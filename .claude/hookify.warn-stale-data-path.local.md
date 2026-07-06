---
name: warn-stale-data-path
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(js|mjs)$
  - field: content
    operator: regex_match
    pattern: raw\.githubusercontent\.com|\.github\.io/.*\.json
---

WARNING: Data read through a cached/static URL detected.

Mise rule (CLAUDE.md Part 2, rule 2): app data is read and written ONLY via the GitHub Contents API with the fine-grained PAT. raw.githubusercontent.com and Pages URLs serve stale cached copies and break the offline-write/conflict-merge model.

Route this through the data-layer client instead.
