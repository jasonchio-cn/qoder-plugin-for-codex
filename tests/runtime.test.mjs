import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runtime = path.join(process.cwd(), "scripts", "qoder-companion.mjs");

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("foreground task runs qodercli without MCP and persists a completed job", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-runtime-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "qodercli");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.1.31"); process.exit(0); }
if (args.includes("--list-models")) { console.log("MODEL\\nUltimate"); process.exit(0); }
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"qoder-session-1",model:"Ultimate"}));
console.log(JSON.stringify({type:"result",subtype:"success",session_id:"qoder-session-1",result:"TASK_OK",is_error:false}));
`);
  fs.chmodSync(fake, 0o755);
  spawnSync("git", ["init", "-q", root]);

  try {
    const result = spawnSync(process.execPath, [runtime, "task", "--cwd", root, "--", "inspect safely"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status: \*\*completed\*\*/);
    assert.match(result.stdout, /TASK_OK/);
    assert.match(result.stdout, /qoder-session-1/);

    const stateRoot = path.join(root, ".git", "qoder-plugin-codex");
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "state.json"), "utf8"));
    assert.equal(state.jobs[0].status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel marks a running background task before terminating its process", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-runtime-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "qodercli");
  fs.writeFileSync(fake, `#!/usr/bin/env node
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"cancel-session",model:"Ultimate"}));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fake, 0o755);
  spawnSync("git", ["init", "-q", root]);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  try {
    const launch = spawnSync(process.execPath, [runtime, "task", "--cwd", root, "--background", "--", "wait"], { encoding: "utf8", env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = launch.stdout.match(/`(task-[^`]+)`/)?.[1];
    assert.ok(jobId);
    const detailFile = path.join(root, ".git", "qoder-plugin-codex", "jobs", `${jobId}.json`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
      if (detail.status === "running" && detail.qoderSessionId) break;
      sleepSync(20);
    }

    const cancel = spawnSync(process.execPath, [runtime, "cancel", jobId, "--cwd", root], { encoding: "utf8", env, timeout: 10_000 });
    assert.equal(cancel.status, 0, cancel.stderr);
    const detail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
    assert.equal(detail.status, "cancelled");
    assert.equal(detail.error, null);
    assert.equal(detail.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
