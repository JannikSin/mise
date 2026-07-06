---
name: warn-unsafe-dom
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(js|mjs|html)$
  - field: content
    operator: regex_match
    pattern: innerHTML\s*=|\beval\s*\(
---

WARNING: Unsafe DOM/code-execution pattern detected (innerHTML assignment or eval).

Recipe and pantry data gets rendered into the page - string-built HTML is an injection surface, and eval violates the strict CSP.

Use instead: htm tagged templates (auto-escaped) or textContent. If you believe this specific use is safe and necessary, say so explicitly in the session and get sign-off before proceeding.
