import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerClient } from "./app-server.mjs";

function responseMessage(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

function textBlocks(content) {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text" && typeof block.text === "string") return [{ kind: "text", text: block.text }];
    if (block?.type === "tool_use") {
      return [{ kind: "tool", text: `[Tool call: ${block.name ?? "unknown"}]\n${JSON.stringify(block.input ?? {}, null, 2)}` }];
    }
    if (block?.type === "tool_result") {
      const value = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null, null, 2);
      return [{ kind: "result", text: `[Tool result${block.tool_use_id ? `: ${block.tool_use_id}` : ""}]\n${value}` }];
    }
    return [];
  });
}

export function parseQoderTranscript(raw) {
  const items = [];
  const warnings = [];
  let cwd = null;
  let sessionId = null;
  let firstUserText = null;
  const seenUuids = new Set();

  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch {
      warnings.push(`Skipped invalid JSON at line ${index + 1}.`);
      continue;
    }
    sessionId ??= entry.sessionId ?? null;
    cwd ??= entry.cwd ?? null;
    if (entry.uuid && seenUuids.has(entry.uuid)) continue;
    if (entry.uuid) seenUuids.add(entry.uuid);
    if (entry.isSidechain || !["user", "assistant"].includes(entry.type)) continue;
    const blocks = textBlocks(entry.message?.content);
    for (const block of blocks) {
      const role = block.kind === "result" ? "user" : entry.type;
      if (role === "user" && block.kind === "text" && !firstUserText) firstUserText = block.text;
      items.push(responseMessage(role, block.text));
    }
  }
  return { items, warnings, cwd, sessionId, firstUserText };
}

export function buildInjectionBatches(items, { maxItems = 100, maxBytes = 1024 * 1024 } = {}) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (itemBytes > maxBytes) throw new Error("A converted session item exceeds the injection byte limit.");
    if (batch.length > 0 && (batch.length >= maxItems || bytes + itemBytes > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function walkJsonl(directory, output = []) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJsonl(candidate, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && !candidate.includes(`${path.sep}subagents${path.sep}`)) output.push(candidate);
  }
  return output;
}

export function findQoderSession({ sessionId = null, latest = false, qoderHome = path.join(os.homedir(), ".qoder") } = {}) {
  const files = walkJsonl(path.join(qoderHome, "projects"));
  if (sessionId) {
    const matches = files.filter((file) => path.basename(file) === `${sessionId}.jsonl`);
    if (matches.length > 1) throw new Error(`Multiple Qoder sessions match ${sessionId}.`);
    if (matches.length === 0) throw new Error(`Qoder session not found: ${sessionId}`);
    return matches[0];
  }
  if (!latest) throw new Error("Provide --session <id> or --latest.");
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0]?.file ?? null;
}

function deriveTitle(parsed, override) {
  if (override) return override;
  const text = parsed.firstUserText?.replace(/\s+/g, " ").trim() || `Qoder session ${parsed.sessionId ?? "import"}`;
  return text.slice(0, 80);
}

export async function transferQoderSession({ sourcePath, targetCwd = null, title = null, clientFactory = CodexAppServerClient.connect } = {}) {
  const parsed = parseQoderTranscript(fs.readFileSync(sourcePath, "utf8"));
  if (parsed.items.length === 0) throw new Error("Qoder session has no model-visible messages to import.");
  const cwd = targetCwd || (parsed.cwd && fs.existsSync(parsed.cwd) ? parsed.cwd : process.cwd());
  const client = await clientFactory(cwd);
  let threadId = null;
  try {
    const started = await client.request("thread/start", {
      cwd,
      ephemeral: false,
      threadSource: "qoder-plugin-for-codex-import",
    });
    threadId = started.thread.id;
    await client.request("thread/name/set", { threadId, name: deriveTitle(parsed, title) });
    for (const batch of buildInjectionBatches(parsed.items)) {
      await client.request("thread/inject_items", { threadId, items: batch });
    }
    return { threadId, cwd, sourcePath, itemCount: parsed.items.length, warnings: parsed.warnings };
  } catch (error) {
    if (threadId) await client.request("thread/delete", { threadId }).catch(() => {});
    throw error;
  } finally {
    await client.close();
  }
}
