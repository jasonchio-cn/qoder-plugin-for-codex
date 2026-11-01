---
name: task
description: Use when the user explicitly asks Qoder to investigate, implement, fix, continue, or independently handle a coding task from Codex.
---

# Qoder Task

Resolve the absolute path `<this-skill-directory>/../../scripts/qoder-companion.mjs`, then run it with Node.

Use `task --background -- <prompt>` by default. Add `--write` only when the user authorized code changes. Add `--worktree` only with `--write` when isolation was requested. Forward explicit `--model` and `--effort` choices.

For follow-ups, use `--resume-last`; use `--resume <session-id>` when the user supplied one. Use `--fresh` when prior Qoder context must not be reused.

Return the job ID and tell the user that `$qoder:jobs` can inspect, wait for, retrieve, or cancel it. Never evaluate the user's prompt as shell syntax; pass it as one quoted argument after `--`.
