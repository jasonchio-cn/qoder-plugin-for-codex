---
name: review
description: Use when the user explicitly asks Qoder for a code review, adversarial review, second opinion, or independent challenge of current changes.
---

# Qoder Review

Resolve the absolute path `<this-skill-directory>/../../scripts/qoder-companion.mjs`, then run `review --background`.

Add `--base <ref>` for branch comparison. Add `--adversarial` when the user wants assumptions, design direction, or tradeoffs challenged. Put any requested review lens in `--focus`.

Review is always read-only. Do not add write permissions or ask Qoder to fix findings. Return the job ID and use `$qoder:jobs` for progress or results.
