// P4: pre-commit hook body. If the staged commit touches app code (app/,
// index.html, vendor/, icons/, manifest) but not sw.js's CACHE_VERSION,
// bump the version and stage sw.js — so every deploy ships a byte-different
// service worker and no client can ever run a half-old module graph.
// Installed as .git/hooks/pre-commit (see tools/install-hooks.mjs; hooks are
// not versioned by git, re-run the installer after a fresh clone).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (/** @type {string[]} */ args) => execFileSync("git", args, { encoding: "utf8" });

const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);

const touchesApp = staged.some(
  (f) =>
    f.startsWith("app/") ||
    f.startsWith("vendor/") ||
    f.startsWith("icons/") ||
    f === "index.html" ||
    f === "manifest.webmanifest",
);
if (!touchesApp) process.exit(0);

const sw = readFileSync("sw.js", "utf8");
const m = sw.match(/const CACHE_VERSION = "mise-shell-v(\d+)"/);
if (!m) {
  console.error("bump-sw-version: CACHE_VERSION marker not found in sw.js");
  process.exit(1);
}

const v = (/** @type {string} */ s) => s.match(/mise-shell-v(\d+)/)?.[1];
/** HEAD:sw.js, or null when it doesn't exist yet (brand-new file / no HEAD) */
const headSw = (() => {
  try {
    return git(["show", "HEAD:sw.js"]);
  } catch {
    return null;
  }
})();
// sw.js new in this very commit: it ships whatever version it carries
if (headSw === null) process.exit(0);

if (staged.includes("sw.js")) {
  // staged copy already carries a version change = nothing to do
  if (v(git(["show", ":sw.js"])) !== v(headSw)) process.exit(0);
  // partial staging: bumping the working tree would silently fold unstaged
  // sw.js edits into the commit — refuse and let the human sort it out
  if (git(["show", ":sw.js"]) !== sw) {
    console.error(
      "bump-sw-version: sw.js is partially staged; bump CACHE_VERSION yourself and re-stage",
    );
    process.exit(1);
  }
} else if (headSw !== sw) {
  // sw.js not staged but the working tree differs from HEAD: a bump+add here
  // would sweep those unstaged edits into the commit — refuse
  console.error(
    "bump-sw-version: sw.js has unstaged edits; stage or stash them, then commit again",
  );
  process.exit(1);
}

const next = Number(m[1]) + 1;
writeFileSync("sw.js", sw.replace(m[0], `const CACHE_VERSION = "mise-shell-v${next}"`));
git(["add", "sw.js"]);
console.log(`bump-sw-version: mise-shell-v${m[1]} -> v${next} (app code staged)`);
