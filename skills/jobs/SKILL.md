---
name: jobs
description: Use when the user wants to inspect, wait for, retrieve, resume from, or cancel a Qoder task or review previously started from Codex.
---

# Qoder Jobs

Resolve the absolute path `<this-skill-directory>/../../scripts/qoder-companion.mjs`.

Map the request to exactly one command:

- list jobs: `status`
- inspect one: `status <job-id>`
- wait: `status <job-id> --wait`
- retrieve final output: `result [job-id]`
- cancel: `cancel [job-id]`

Preserve the returned Markdown. Do not summarize away job IDs, Qoder session IDs, errors, or final findings.
