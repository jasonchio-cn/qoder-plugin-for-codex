import assert from "node:assert/strict";
import test from "node:test";

import { buildQoderArgs, parseQoderLine } from "../scripts/lib/qoder.mjs";

test("buildQoderArgs keeps prompts out of the shell and applies safe review defaults", () => {
  const args = buildQoderArgs({
    kind: "review",
    prompt: "review $(touch /tmp/not-run)",
    cwd: "/repo",
    model: "Ultimate",
    effort: "high",
  });

  assert.deepEqual(args.slice(0, 4), ["--print", "--output-format", "stream-json", "--cwd"]);
  assert.equal(args.at(-1), "review $(touch /tmp/not-run)");
  const toolsIndex = args.indexOf("--tools");
  assert.deepEqual(args.slice(toolsIndex, toolsIndex + 4), ["--tools", "Read", "Grep", "Glob"]);
  assert.equal(args.at(-2), "--");
  assert.ok(args.includes("--no-session-persistence"));
});

test("parseQoderLine extracts session, progress and final result", () => {
  assert.deepEqual(parseQoderLine('{"type":"system","subtype":"init","session_id":"s1","model":"Ultimate"}'), {
    type: "init",
    sessionId: "s1",
    model: "Ultimate",
  });
  assert.deepEqual(parseQoderLine('{"type":"result","subtype":"success","session_id":"s1","result":"done","is_error":false}'), {
    type: "result",
    sessionId: "s1",
    status: "completed",
    text: "done",
    error: null,
  });
  assert.equal(parseQoderLine("not json"), null);
});
