import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false, maxBuffer: 2 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error ?? new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout ?? "";
}

export function resolveWorkspaceRoot(cwd) {
  const output = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true }).trim();
  return output || path.resolve(cwd);
}

function truncate(text, limit = 96 * 1024) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[diff truncated]`;
}

export function collectReviewContext(cwd, { base = null } = {}) {
  const root = resolveWorkspaceRoot(cwd);
  const status = git(root, ["status", "--short"], { allowFailure: true });
  const trackedDiff = base
    ? git(root, ["diff", "--find-renames", `${base}...HEAD`], { allowFailure: true })
    : `${git(root, ["diff", "--cached"], { allowFailure: true })}\n${git(root, ["diff"], { allowFailure: true })}`;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { allowFailure: true })
    .split("\0")
    .filter(Boolean)
    .flatMap((relative) => {
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(`${root}${path.sep}`)) return [];
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { return []; }
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      if (stat.size > 64 * 1024) return [`Untracked file: ${relative}\n[file omitted: ${stat.size} bytes]`];
      const content = fs.readFileSync(absolute);
      if (content.includes(0)) return [`Untracked file: ${relative}\n[binary file omitted]`];
      return [`Untracked file: ${relative}\n${content.toString("utf8")}`];
    })
    .join("\n\n");
  const diff = [trackedDiff.trim(), untracked].filter(Boolean).join("\n\n");
  return { root, status: truncate(status, 16 * 1024), diff: truncate(diff) };
}

export function buildReviewPrompt(context, { adversarial = false, focus = "" } = {}) {
  const lens = adversarial
    ? "Challenge the implementation direction, assumptions, tradeoffs, and hidden failure modes."
    : "Review the changes for concrete correctness, security, compatibility, and maintainability problems.";
  return [
    "You are an independent code reviewer. Do not modify files.",
    lens,
    focus ? `Focus requested by the user: ${focus}` : "",
    "Report only actionable findings. For each finding include severity, file/line when available, evidence, and impact. If there are no findings, say so explicitly.",
    `Workspace: ${context.root}`,
    "Git status:",
    context.status || "(clean)",
    "Diff:",
    context.diff || "(no diff)",
  ].filter(Boolean).join("\n\n");
}
