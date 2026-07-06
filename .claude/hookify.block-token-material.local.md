---
name: block-token-material
enabled: true
event: file
action: block
conditions:
  - field: content
    operator: regex_match
    pattern: github_pat_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]{10,}
---

BLOCKED: Token material detected in file content.

You are writing what looks like a real GitHub PAT or Anthropic API key into a file.

Mise rule (CLAUDE.md Part 2, rule 7): secrets live ONLY in browser localStorage or Cloudflare Worker env - never in code, never in the repo, never in any file on disk.

Use a placeholder like YOUR_PAT_HERE instead. If this is a real token that was pasted into the conversation, tell David it should be rotated.
