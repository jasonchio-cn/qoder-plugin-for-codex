---
name: transfer
description: Use when the user wants to continue an existing Qoder conversation inside Codex or convert Qoder history into a resumable Codex thread.
---

# Qoder Transfer

Resolve the absolute path `<this-skill-directory>/../../scripts/qoder-companion.mjs`.

Use `transfer --session <qoder-session-id>` for an explicit session or `transfer --latest` only when the user asks for the latest Qoder session. Add `--title` only when requested.

The command converts Qoder's top-level model-visible history and injects it into a new persistent Codex thread. Return the thread ID and exact `codex resume` command. Surface conversion warnings without claiming proprietary Qoder events or attachments were losslessly migrated.
