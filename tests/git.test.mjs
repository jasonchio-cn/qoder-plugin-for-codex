import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { collectReviewContext } from "../scripts/lib/git.mjs";

test("collectReviewContext includes bounded untracked file contents", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".test-git-"));
  try {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, "new-file.js"), "export const answer = 42;\n");
    const context = collectReviewContext(root);
    assert.match(context.status, /new-file\.js/);
    assert.match(context.diff, /Untracked file: new-file\.js/);
    assert.match(context.diff, /export const answer = 42/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
