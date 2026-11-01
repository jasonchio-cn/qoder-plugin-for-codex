import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STATE_VERSION = 1;
const MAX_JOBS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function atomicWrite(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function withLock(lockFile, callback) {
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + 5_000;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw error;
      sleepSync(20);
    }
  }
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export function resolveStateRoot(cwd) {
  const pluginData = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, "state");

  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--git-path", "qoder-plugin-codex"], {
    encoding: "utf8",
    shell: false,
  });
  if (git.status === 0 && git.stdout.trim()) {
    const candidate = git.stdout.trim();
    return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  }

  const hash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "qoder-plugin-codex-state", hash);
}

export function createStateStore(root) {
  const stateFile = path.join(root, "state.json");
  const jobsDir = path.join(root, "jobs");
  const lockFile = path.join(root, ".state.lock");

  function loadIndex() {
    const parsed = readJson(stateFile, { version: STATE_VERSION, jobs: [] });
    return {
      version: STATE_VERSION,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  }

  function detailFile(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
    return path.join(jobsDir, `${id}.json`);
  }

  function logFile(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
    return path.join(jobsDir, `${id}.log`);
  }

  function upsert(job) {
    if (!job?.id) throw new Error("Job id is required.");
    return withLock(lockFile, () => {
      const now = new Date().toISOString();
      const previousDetail = readJson(detailFile(job.id), {});
      const detail = {
        createdAt: previousDetail.createdAt ?? job.createdAt ?? now,
        ...previousDetail,
        ...job,
        updatedAt: now,
      };
      atomicWrite(detailFile(job.id), detail);

      const state = loadIndex();
      const previousSummary = state.jobs.find((entry) => entry.id === job.id) ?? {};
      const summary = {
        createdAt: previousSummary.createdAt ?? detail.createdAt,
        ...previousSummary,
        id: detail.id,
        kind: detail.kind,
        status: detail.status,
        phase: detail.phase ?? null,
        title: detail.title ?? null,
        qoderSessionId: detail.qoderSessionId ?? null,
        pid: detail.pid ?? null,
        completedAt: detail.completedAt ?? null,
        updatedAt: detail.updatedAt,
      };
      state.jobs = [summary, ...state.jobs.filter((entry) => entry.id !== job.id)]
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        .slice(0, MAX_JOBS);
      atomicWrite(stateFile, state);
      return detail;
    });
  }

  function list(predicate = () => true) {
    return loadIndex().jobs.filter(predicate);
  }

  function resolve(reference, predicate = () => true) {
    const jobs = list(predicate);
    if (!reference) return jobs[0] ?? null;
    const exact = jobs.find((job) => job.id === reference);
    if (exact) return exact;
    const matches = jobs.filter((job) => job.id.startsWith(reference));
    if (matches.length > 1) throw new Error(`Job reference is ambiguous: ${reference}`);
    return matches[0] ?? null;
  }

  function readDetail(id) {
    const detail = readJson(detailFile(id), null);
    if (!detail) throw new Error(`Job not found: ${id}`);
    return detail;
  }

  function appendLog(id, message) {
    ensureDir(jobsDir);
    fs.appendFileSync(logFile(id), `[${new Date().toISOString()}] ${String(message).trim()}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return { root, upsert, list, resolve, readDetail, appendLog, detailFile, logFile };
}

export function createJobId(prefix = "task") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
