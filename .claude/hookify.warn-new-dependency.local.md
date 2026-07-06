---
name: warn-new-dependency
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: package\.json$
  - field: content
    operator: regex_match
    pattern: "\"(dependencies|devDependencies)\""
---

WARNING: package.json dependency change.

Mise rule (CLAUDE.md Part 2, rule 5): no new dependencies without stated justification that David approves. Runtime dependencies are near-forbidden (zero-build, vendored-only); dev-tooling additions need a one-line justification.

If David already approved this exact change, proceed. Otherwise stop and ask first.
