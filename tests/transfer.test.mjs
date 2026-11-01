import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";

import { buildInjectionBatches, parseQoderTranscript, transferQoderSession } from "../scripts/lib/transfer.mjs";

test("parseQoderTranscript converts text and tool events without telemetry", () => {
  const transcript = [
    JSON.stringify({ type: "runtime-config", sessionId: "s1" }),
    JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "README.md" } }] } }),
    JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } }),
    "broken json",
  ].join("\n");

  const result = parseQoderTranscript(transcript);
  assert.equal(result.items.length, 4);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.items[0].role, "user");
  assert.match(result.items[2].content[0].text, /Tool call: Read/);
  assert.match(result.items[3].content[0].text, /Tool result/);
});

test("buildInjectionBatches respects item and byte limits", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `message-${index}` }],
  }));
  const batches = buildInjectionBatches(items, { maxItems: 2, maxBytes: 10_000 });
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 1]);
});

test("transferQoderSession creates, names and injects a persistent Codex thread", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-transfer-"));
  const sourcePath = path.join(root, "session.jsonl");
  fs.writeFileSync(sourcePath, [
    JSON.stringify({ type: "user", sessionId: "q1", cwd: root, message: { content: "remember TOKEN_1" } }),
    JSON.stringify({ type: "assistant", sessionId: "q1", cwd: root, message: { content: [{ type: "text", text: "stored" }] } }),
  ].join("\n"));

  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    },
    async close() {},
  };

  try {
    const result = await transferQoderSession({ sourcePath, clientFactory: async () => client });
    assert.equal(result.threadId, "thread-1");
    assert.deepEqual(calls.map((call) => call.method), ["thread/start", "thread/name/set", "thread/inject_items"]);
    assert.equal(calls[0].params.ephemeral, false);
    assert.equal(calls[2].params.items.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
