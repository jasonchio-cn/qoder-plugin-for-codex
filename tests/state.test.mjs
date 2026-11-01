import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createStateStore } from "../scripts/lib/state.mjs";

test("state store persists jobs and resolves unambiguous prefixes", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-state-"));
  try {
    const store = createStateStore(root);
    store.upsert({ id: "task-abc123", status: "queued", kind: "task" });
    store.upsert({ id: "review-def456", status: "completed", kind: "review" });

    assert.equal(store.resolve("task-abc").id, "task-abc123");
    assert.equal(store.list().length, 2);
    assert.equal(store.readDetail("task-abc123").status, "queued");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state store rejects ambiguous prefixes and keeps at most 50 jobs", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-state-"));
  try {
    const store = createStateStore(root);
    store.upsert({ id: "task-same-1", status: "queued", kind: "task" });
    store.upsert({ id: "task-same-2", status: "queued", kind: "task" });
    assert.throws(() => store.resolve("task-same"), /ambiguous/i);

    for (let index = 0; index < 55; index += 1) {
      store.upsert({ id: `task-${index}`, status: "completed", kind: "task" });
    }
    assert.equal(store.list().length, 50);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state store recovers a stale lock left by a crashed process", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-state-"));
  try {
    fs.writeFileSync(path.join(root, ".state.lock"), "stale");
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, ".state.lock"), stale, stale);
    const store = createStateStore(root);
    assert.equal(store.upsert({ id: "task-after-crash", status: "queued", kind: "task" }).status, "queued");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
