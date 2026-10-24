// NO EM DASHES ON SCREEN (David: no em dash in anything he reads). Scans every
// .js under app/ and worker/src, skips comments (// and /* */, so JSDoc too),
// and fails on any em dash left in code, which is where on-screen strings,
// toasts, aria-labels and worker replies live. Comments may keep them.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const EM = "\u2014";

/** Indexes of em dashes that sit outside comments. */
function emDashesOutsideComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let mode = "code";
  const tstack = [];
  while (i < n) {
    const c = src[i],
      d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "lc";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        mode = "bc";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        mode = c;
        i++;
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        i++;
        continue;
      }
      if (c === "}" && tstack.length && tstack[tstack.length - 1] === 0) {
        tstack.pop();
        mode = "tpl";
        i++;
        continue;
      }
      if (c === "{" && tstack.length) tstack[tstack.length - 1]++;
      if (c === "}" && tstack.length) tstack[tstack.length - 1]--;
      if (c === "/") {
        // regex heuristic
        let j = i - 1;
        while (j >= 0 && /\s/.test(src[j])) j--;
        if (
          j < 0 ||
          /[=(,:;!&|?{}[+\-*%<>~^]/.test(src[j]) ||
          /\b(return|typeof)$/.test(src.slice(Math.max(0, j - 6), j + 1))
        ) {
          i++;
          let cls = false;
          while (i < n && (src[i] !== "/" || cls) && src[i] !== "\n") {
            if (src[i] === "\\") i++;
            else if (src[i] === "[") cls = true;
            else if (src[i] === "]") cls = false;
            if (src[i] === EM) out.push(i);
            i++;
          }
          i++;
          continue;
        }
      }
      if (c === EM) out.push(i);
      i++;
      continue;
    }
    if (mode === "lc") {
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "bc") {
      if (c === "*" && d === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === mode || c === "\n") mode = "code";
      else if (c === EM) out.push(i);
      i++;
      continue;
    }
    if (mode === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        mode = "code";
        i++;
        continue;
      }
      if (c === "$" && d === "{") {
        tstack.push(0);
        mode = "code";
        i += 2;
        continue;
      }
      if (c === EM) out.push(i);
      i++;
      continue;
    }
  }
  return out;
}

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : jsFiles(p);
    return p.endsWith(".js") ? [p] : [];
  });
}

test("no em dash survives in app/ or worker/src code outside comments", () => {
  const found = [];
  for (const f of [...jsFiles("app"), ...jsFiles("worker/src")]) {
    const s = readFileSync(f, "utf8");
    for (const i of emDashesOutsideComments(s)) {
      const line = s.slice(0, i).split("\n").length;
      found.push(`${f}:${line}: ${s.split("\n")[line - 1].trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(found, [], "em dash on screen, use a comma, colon or period");
});

test("the em dash scanner ignores comments but catches strings and templates", () => {
  const a = `// ${EM} comment\n/* ${EM} */ const x = 1; /** ${EM} */`;
  assert.deepEqual(emDashesOutsideComments(a), []);
  assert.equal(emDashesOutsideComments(`const s = "a ${EM} b";`).length, 1);
  assert.equal(emDashesOutsideComments(`const s = \`a \${x} ${EM} b\`;`).length, 1);
});

test("the em dash scanner handles a regex literal and a template with an expression", () => {
  // the regex holds a dash-free class, the template holds ${} then a dash
  // after it: the dash after the expression must still be caught, and the
  // regex must not swallow the quote that follows it
  const src = `const r = /[a-z]+"/g; const s = \`\${r.test("x")} ${EM} b\`; // ${EM} c`;
  assert.equal(emDashesOutsideComments(src).length, 1);
  assert.equal(emDashesOutsideComments(`const r = /a${EM}b/;`).length, 1, "a dash in a regex literal counts");
});

test("no em dash in the manifest, the page text, or the service worker", () => {
  const found = [];
  const manifest = readFileSync("manifest.webmanifest", "utf8");
  if (manifest.includes(EM)) found.push("manifest.webmanifest");
  // visible text: HTML comments, scripts and styles are not what a person reads
  const page = readFileSync("index.html", "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  if (page.includes(EM)) found.push("index.html");
  const sw = readFileSync("sw.js", "utf8");
  if (emDashesOutsideComments(sw).length) found.push("sw.js");
  assert.deepEqual(found, [], "em dash in a file a person reads, use a comma, colon or period");
});
