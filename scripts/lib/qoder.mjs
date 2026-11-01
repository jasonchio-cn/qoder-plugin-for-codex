import { spawn } from "node:child_process";
import readline from "node:readline";

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function buildQoderArgs(options) {
  const args = ["--print", "--output-format", "stream-json", "--cwd", options.cwd];
  if (options.kind === "review") {
    args.push("--no-session-persistence", "--permission-mode", "dont_ask", "--tools", "Read", "Grep", "Glob");
  } else if (options.write) {
    args.push("--permission-mode", "accept_edits");
  } else {
    args.push("--permission-mode", "dont_ask", "--tools", "Read", "Grep", "Glob");
  }
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--reasoning-effort", options.effort);
  if (options.resume) args.push("--resume", options.resume);
  if (options.worktree) {
    args.push("--worktree");
    if (typeof options.worktree === "string") args.push(options.worktree);
  }
  args.push("--", options.prompt);
  return args;
}

export function parseQoderLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return null; }

  if (message.type === "system" && message.subtype === "init") {
    return { type: "init", sessionId: message.session_id ?? null, model: message.model ?? null };
  }
  if (message.type === "system") {
    return { type: "progress", phase: message.subtype ?? "system", text: message.message ?? null };
  }
  if (message.type === "assistant") {
    const text = textFromContent(message.message?.content ?? message.content);
    return text ? { type: "assistant", text } : { type: "progress", phase: "assistant", text: null };
  }
  if (message.type === "result") {
    const success = message.subtype === "success" && message.is_error !== true;
    return {
      type: "result",
      sessionId: message.session_id ?? null,
      status: success ? "completed" : "failed",
      text: typeof message.result === "string" ? message.result : "",
      error: success ? null : String(message.error ?? message.result ?? message.subtype ?? "Qoder failed"),
    };
  }
  return null;
}

export function runQoder(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? "qodercli", buildQoderArgs(options), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    options.onSpawn?.(child.pid);

    let stderr = "";
    let finalEvent = null;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_768);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseQoderLine(line);
      if (!event) return;
      if (event.type === "result") finalEvent = event;
      options.onEvent?.(event);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (finalEvent) {
        resolve({ ...finalEvent, exitCode: code ?? 0, signal, stderr: stderr.trim() });
        return;
      }
      resolve({
        type: "result",
        status: code === 0 ? "completed" : "failed",
        text: "",
        error: code === 0 ? null : stderr.trim() || `qodercli exited with ${code ?? signal}`,
        sessionId: null,
        exitCode: code ?? 1,
        signal,
        stderr: stderr.trim(),
      });
    });
  });
}
