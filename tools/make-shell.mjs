// THE SWITCH-MORNING SHELLS (Mise 2.0, gate20 Realist R3). The app picks its
// backend from the served index.html (docs/supabase-shell.md), so the switch
// needs two shells, each a commit released by the normal train:
//   A  --move           GitHub backend plus <meta name="mise-move" content="on">
//                       (the admin's FREEZE control), for 6:00 am until --final
//   B  --supabase live  <meta name="mise-backend" content="supabase"> plus the
//                       project's origin in the CSP connect-src, after --final
//   --supabase sandbox  the same for Mise NEXT (plan step 12)
//   --plain             back to the committed 1.x shell (no meta, no project origin)
// The project origin comes from app/lib/backend/config.js; a placeholder there
// is refused, so a shell can never point at a project that is not set up.
//
//   node tools/make-shell.mjs index.html --move | --supabase live|sandbox | --plain   (prints what changes)
//   ... --write                                                                     (rewrites the file)

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SUPABASE_LIVE, SUPABASE_SANDBOX } from "../app/lib/backend/config.js";

const BACKEND = /\n\s*<meta name="mise-backend" content="[^"]*" \/>/g;
const MOVE = /\n\s*<meta name="mise-move" content="[^"]*" \/>/g;
const ANCHOR = /(\n(\s*)<meta name="mise-data-branch" content="[^"]*" \/>)/;
const SUPA_ORIGIN = / https:\/\/[a-z0-9]+\.supabase\.co/g;

/**
 * The shell's HTML for one mode. Pure.
 * @param {string} html
 * @param {"move" | "supabase" | "plain"} mode
 * @param {{ url: string } | null} [project] for "supabase"
 * @returns {string}
 */
export function makeShell(html, mode, project = null) {
  if (!ANCHOR.test(html)) throw new Error("index.html has no mise-data-branch meta to anchor on");
  if (!/connect-src [^;]*;/.test(html)) throw new Error("index.html has no CSP connect-src");
  let out = html.replace(BACKEND, "").replace(MOVE, "").replace(SUPA_ORIGIN, "");
  if (mode === "move") out = out.replace(ANCHOR, `$1\n$2<meta name="mise-move" content="on" />`);
  if (mode === "supabase") {
    const origin = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(String(project?.url ?? ""));
    if (!origin || /YOUR|PLACEHOLDER/i.test(String(project?.url)))
      throw new Error("the project URL in app/lib/backend/config.js is still a placeholder; commit the real one first");
    out = out
      .replace(ANCHOR, `$1\n$2<meta name="mise-backend" content="supabase" />`)
      .replace(/connect-src 'self'/, `connect-src 'self' https://${origin[1]}.supabase.co`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, live?: { url: string }, sandbox?: { url: string } }} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const file = argv.find((a) => !a.startsWith("--") && a !== "live" && a !== "sandbox");
  const write = argv.includes("--write");
  const which = argv[argv.indexOf("--supabase") + 1];
  /** @type {"move" | "supabase" | "plain" | null} */
  const mode = argv.includes("--move") ? "move" : argv.includes("--supabase") ? "supabase" : argv.includes("--plain") ? "plain" : null;
  if (!file || !mode || (mode === "supabase" && which !== "live" && which !== "sandbox")) {
    log("usage: node tools/make-shell.mjs <index.html> --move | --supabase live|sandbox | --plain [--write]");
    return 2;
  }
  const project = which === "sandbox" ? (io.sandbox ?? SUPABASE_SANDBOX) : (io.live ?? SUPABASE_LIVE);
  const before = readFileSync(file, "utf8");
  let after;
  try {
    after = makeShell(before, mode, project);
  } catch (e) {
    log(`refused: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const meta = (/** @type {string} */ h) =>
    [h.match(BACKEND) ? "backend supabase" : "backend github", h.match(MOVE) ? "move on" : "move off", (h.match(SUPA_ORIGIN) ?? []).length ? "project origin in CSP" : "no project origin"].join(", ");
  log(`${file}: ${meta(before)} -> ${meta(after)}${before === after ? " (no change)" : ""}`);
  if (write && before !== after) writeFileSync(file, after);
  if (!write) log("dry run: add --write, then commit the shell and release it with the train");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
