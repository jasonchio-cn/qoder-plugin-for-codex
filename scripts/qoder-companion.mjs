#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildReviewPrompt, collectReviewContext, resolveWorkspaceRoot } from "./lib/git.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { runQoder } from "./lib/qoder.mjs";
import { createJobId, createStateStore, resolveStateRoot } from "./lib/state.mjs";
import { findQoderSession, transferQoderSession } from "./lib/transfer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function optionName(raw) {
  return raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv, valueOptions = new Set()) {
  const options = {};
  const positionals = [];
  let afterSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (afterSeparator) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const rawName = token.slice(2, equals === -1 ? undefined : equals);
    const name = optionName(rawName);
    if (equals !== -1) {
      options[name] = token.slice(equals + 1);
    } else if (valueOptions.has(rawName)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${rawName} requires a value.`);
      options[name] = value;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { options, positionals };
}

function storeFor(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return { workspaceRoot, store: createStateStore(resolveStateRoot(workspaceRoot)) };
}

function renderJob(job) {
  const lines = [
    `## ${job.title || job.id}`,
    "",
    `- Job: \`${job.id}\``,
    `- Status: **${job.status}**`,
    `- Phase: ${job.phase || "unknown"}`,
  ];
  if (job.qoderSessionId) lines.push(`- Qoder session: \`${job.qoderSessionId}\``);
  if (job.error) lines.push(`- Error: ${job.error}`);
  if (job.result) lines.push("", job.result);
  return lines.join("\n");
}

function progressForEvent(event) {
  if (event.type === "init") return { phase: "running", message: `Qoder session ${event.sessionId} started${event.model ? ` with ${event.model}` : ""}.` };
  if (event.type === "progress") return { phase: event.phase || "running", message: event.text || `Qoder ${event.phase || "progress"}.` };
  if (event.type === "assistant") return { phase: "responding", message: "Qoder produced an assistant message." };
  return null;
}

async function runTrackedJob(store, job) {
  const startedAt = new Date().toISOString();
  store.upsert({ ...job, status: "running", phase: "starting", startedAt, pid: process.pid });
  store.appendLog(job.id, `Starting ${job.kind}.`);

  let qoderSessionId = job.qoderSessionId ?? null;
  let prompt = job.request.prompt;
  if (job.kind === "review") {
    const context = collectReviewContext(job.workspaceRoot, { base: job.request.base });
    prompt = buildReviewPrompt(context, {
      adversarial: job.request.adversarial,
      focus: job.request.focus,
    });
  }

  try {
    const result = await runQoder({
      kind: job.kind,
      cwd: job.workspaceRoot,
      prompt,
      write: job.request.write,
      model: job.request.model,
      effort: job.request.effort,
      resume: job.request.resume,
      worktree: job.request.worktree,
      onSpawn(pid) {
        store.upsert({ id: job.id, pid, phase: "launching" });
      },
      onEvent(event) {
        if (event.sessionId) qoderSessionId = event.sessionId;
        const progress = progressForEvent(event);
        if (!progress) return;
        store.appendLog(job.id, progress.message);
        if (event.type === "init" || event.type === "progress") {
          store.upsert({ id: job.id, phase: progress.phase, qoderSessionId });
        }
      },
    });

    const current = store.readDetail(job.id);
    if (current.status === "cancelled") return current;
    const completedAt = new Date().toISOString();
    const status = result.status;
    const final = store.upsert({
      id: job.id,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      qoderSessionId: result.sessionId || qoderSessionId,
      completedAt,
      result: result.text || null,
      error: result.error || null,
      exitCode: result.exitCode,
    });
    store.appendLog(job.id, status === "completed" ? "Completed." : `Failed: ${result.error}`);
    return final;
  } catch (error) {
    const current = store.readDetail(job.id);
    if (current.status === "cancelled") return current;
    const final = store.upsert({
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: new Date().toISOString(),
      error: error.message,
    });
    store.appendLog(job.id, `Failed: ${error.message}`);
    return final;
  }
}

function createJob(kind, cwd, request) {
  const { workspaceRoot, store } = storeFor(cwd);
  const id = createJobId(kind === "review" ? "review" : "task");
  const title = kind === "review"
    ? `${request.adversarial ? "Adversarial " : ""}Qoder review`
    : `Qoder task: ${request.prompt.replace(/\s+/g, " ").slice(0, 72)}`;
  const job = {
    id,
    kind,
    status: "queued",
    phase: "queued",
    title,
    workspaceRoot,
    request,
    pid: null,
  };
  store.upsert(job);
  return { store, job };
}

function enqueue(store, job) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "job-worker", "--cwd", job.workspaceRoot, "--job-id", job.id], {
    cwd: job.workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.unref();
  return store.upsert({ id: job.id, pid: child.pid ?? null, phase: "queued" });
}

async function handleSetup(argv) {
  const { options } = parseArgs(argv, new Set(["cwd"]));
  const cwd = path.resolve(options.cwd || process.cwd());
  const checks = [
    ["Node.js", process.execPath, ["--version"]],
    ["Qoder CLI", "qodercli", ["--version"]],
    ["Qoder login/models", "qodercli", ["--list-models"]],
    ["Codex CLI", "codex", ["--version"]],
    ["Codex App Server", "codex", ["app-server", "--help"]],
  ].map(([name, command, args]) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, timeout: 30_000 });
    return {
      name,
      ready: !result.error && result.status === 0,
      detail: (result.stdout || result.stderr || result.error?.message || "unknown").trim().split("\n")[0],
    };
  });
  const ready = checks.every((check) => check.ready);
  console.log(["## Qoder plugin setup", "", ...checks.map((check) => `- ${check.ready ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`), "", `Ready: **${ready}**`].join("\n"));
  if (!ready) process.exitCode = 1;
}

function resolveResume(store, options) {
  if (options.fresh) return null;
  if (typeof options.resume === "string") return options.resume;
  if (!options.resumeLast) return null;
  const candidate = store.list((job) => job.kind === "task" && job.status === "completed" && job.qoderSessionId)[0];
  if (!candidate) throw new Error("No completed Qoder task is available to resume.");
  return candidate.qoderSessionId;
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, new Set(["cwd", "model", "effort", "resume"]));
  const prompt = positionals.join(" ").trim();
  if (!prompt && !options.resumeLast && !options.resume) throw new Error("Provide a task prompt or a resume option.");
  if (options.worktree && !options.write) throw new Error("--worktree requires --write.");
  const cwd = path.resolve(options.cwd || process.cwd());
  const { store } = storeFor(cwd);
  const request = {
    prompt,
    write: Boolean(options.write),
    model: options.model || null,
    effort: options.effort || null,
    resume: resolveResume(store, options),
    worktree: options.worktree || null,
  };
  const created = createJob("task", cwd, request);
  if (options.background && !options.wait) {
    console.log(renderJob(enqueue(created.store, created.job)));
    return;
  }
  console.log(renderJob(await runTrackedJob(created.store, created.job)));
}

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, new Set(["cwd", "model", "effort", "base", "focus"]));
  if (positionals.length && !options.focus) options.focus = positionals.join(" ");
  const cwd = path.resolve(options.cwd || process.cwd());
  const request = {
    prompt: "",
    base: options.base || null,
    focus: options.focus || "",
    adversarial: Boolean(options.adversarial),
    write: false,
    model: options.model || null,
    effort: options.effort || null,
    resume: null,
    worktree: null,
  };
  const created = createJob("review", cwd, request);
  if (options.background && !options.wait) {
    console.log(renderJob(enqueue(created.store, created.job)));
    return;
  }
  console.log(renderJob(await runTrackedJob(created.store, created.job)));
}

async function waitForJob(store, id, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = store.readDetail(id);
    if (TERMINAL_STATUSES.has(detail.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for job ${id}.`);
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, new Set(["cwd", "timeout"]));
  const { store } = storeFor(path.resolve(options.cwd || process.cwd()));
  const reference = positionals[0] || null;
  if (reference) {
    const summary = store.resolve(reference);
    if (!summary) throw new Error(`Job not found: ${reference}`);
    const detail = options.wait ? await waitForJob(store, summary.id, Number(options.timeout || 240_000)) : store.readDetail(summary.id);
    console.log(renderJob(detail));
    return;
  }
  const jobs = store.list();
  if (!jobs.length) {
    console.log("No Qoder jobs for this workspace.");
    return;
  }
  console.log(["| Job | Kind | Status | Phase |", "| --- | --- | --- | --- |", ...jobs.map((job) => `| \`${job.id}\` | ${job.kind} | ${job.status} | ${job.phase || "-"} |`)].join("\n"));
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, new Set(["cwd"]));
  const { store } = storeFor(path.resolve(options.cwd || process.cwd()));
  const summary = store.resolve(positionals[0] || null, (job) => TERMINAL_STATUSES.has(job.status));
  if (!summary) throw new Error("No finished Qoder job found.");
  console.log(renderJob(store.readDetail(summary.id)));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, new Set(["cwd"]));
  const { store } = storeFor(path.resolve(options.cwd || process.cwd()));
  const summary = store.resolve(positionals[0] || null, (job) => !TERMINAL_STATUSES.has(job.status));
  if (!summary) throw new Error("No active Qoder job found.");
  const detail = store.readDetail(summary.id);
  store.upsert({
    id: detail.id,
    status: "cancelled",
    phase: "cancelling",
    error: null,
    result: null,
    completedAt: new Date().toISOString(),
  });
  if (detail.pid) await terminateProcessTree(detail.pid);
  const cancelled = store.upsert({
    id: detail.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    error: null,
    result: null,
    completedAt: new Date().toISOString(),
  });
  store.appendLog(detail.id, "Cancelled by user.");
  console.log(renderJob(cancelled));
}

async function handleTransfer(argv) {
  const { options } = parseArgs(argv, new Set(["cwd", "session", "title"]));
  const sourcePath = findQoderSession({ sessionId: options.session || null, latest: Boolean(options.latest) });
  if (!sourcePath) throw new Error("No Qoder session found.");
  const result = await transferQoderSession({
    sourcePath,
    targetCwd: options.cwd ? path.resolve(options.cwd) : null,
    title: options.title || null,
  });
  console.log([
    "## Qoder session transferred",
    "",
    `- Codex thread: \`${result.threadId}\``,
    `- Imported items: ${result.itemCount}`,
    `- Workspace: \`${result.cwd}\``,
    "",
    `Resume with: \`codex resume ${result.threadId}\``,
    ...(result.warnings.length ? ["", `Warnings: ${result.warnings.join(" ")}`] : []),
  ].join("\n"));
}

async function handleWorker(argv) {
  const { options } = parseArgs(argv, new Set(["cwd", "job-id"]));
  if (!options.jobId) throw new Error("job-worker requires --job-id.");
  const { store } = storeFor(path.resolve(options.cwd || process.cwd()));
  const job = store.readDetail(options.jobId);
  const result = await runTrackedJob(store, job);
  if (result.status === "failed") process.exitCode = 1;
}

function printUsage() {
  console.log("Usage: qoder-companion.mjs <setup|task|review|status|result|cancel|transfer> [options]");
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup": await handleSetup(argv); break;
    case "task": await handleTask(argv); break;
    case "review": await handleReview(argv); break;
    case "status": await handleStatus(argv); break;
    case "result": handleResult(argv); break;
    case "cancel": await handleCancel(argv); break;
    case "transfer": await handleTransfer(argv); break;
    case "job-worker": await handleWorker(argv); break;
    default: printUsage(); process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(`qoder-plugin-for-codex: ${error.message}`);
  process.exitCode = 1;
});
