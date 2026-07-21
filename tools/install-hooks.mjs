// Installs the repo's git hooks (.git/hooks is not versioned — run once per
// clone: `node tools/install-hooks.mjs`). Currently: pre-commit SW version
// bump (P4).
import { writeFileSync, chmodSync } from "node:fs";

const hook = `#!/bin/sh
# installed by tools/install-hooks.mjs — do not edit here
node tools/bump-sw-version.mjs || exit 1
`;

writeFileSync(".git/hooks/pre-commit", hook);
try {
  chmodSync(".git/hooks/pre-commit", 0o755);
} catch {
  // Windows: git honors the shebang without the mode bit
}
console.log("installed .git/hooks/pre-commit (SW version bump)");
