// Mise 2.0, the bank scrub (decision 3): tools/bank-scrub.mjs on SYNTHETIC
// clones built in the OS temp folder. Made-up people only ("Guest Quill",
// "housemate-1"); no real data is ever read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTerms,
  hasWord,
  scrubString,
  proposeEdit,
  scanBank,
  main,
} from "../tools/bank-scrub.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const ROSTER = {
  profiles: [
    { id: "host-1", name: "Hosta Admin", admin: true, household: "house-w" },
    { id: "quill", name: "Guest Quill", household: "house-f", family: "zephyrine" },
    { id: "housemate-1", name: "Marlowe Tibbs", household: "house-w" },
    { id: "al", name: "Al B", household: "house-w" },
  ],
};

/** a synthetic clone in the temp folder */
function clone() {
  const dir = mkdtempSync(join(tmpdir(), "bank-scrub-data-"));
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(ROSTER));
  mkdirSync(join(dir, "profiles", "quill"), { recursive: true });
  mkdirSync(join(dir, "profiles", "orphan-slug"), { recursive: true });
  mkdirSync(join(dir, "recipes"), { recursive: true });
  mkdirSync(join(dir, "recipes-staging"), { recursive: true });
  const put = (/** @type {string} */ p, /** @type {any} */ d) =>
    writeFileSync(join(dir, p), JSON.stringify(d));
  put("recipes/quills-lasagna.json", {
    id: "quills-lasagna",
    name: "Quill's Lasagna",
    tags: ["dinner", "from-quill"],
    notes: "Made for Marlowe on his birthday. Hosta likes extra basil.",
    ingredients: [{ food: "pasta" }],
  });
  put("recipes/chamomile-tea.json", {
    id: "chamomile-tea",
    name: "Chamomile tea",
    notes: "cardamom optional",
  });
  put("recipes/plain-dal.json", {
    id: "plain-dal",
    name: "Plain dal",
    notes: "a Zephyrine family recipe",
  });
  put("recipes-staging/tibbs-toast.json", {
    id: "tibbs-toast",
    name: "Toast",
    notes: "tibbs approved",
  });
  return dir;
}

test("terms come from the clone's roster and folders, never the admin's, never short words", () => {
  const t = buildTerms(ROSTER, ["quill", "orphan-slug", "host-1"]);
  assert.deepEqual(t, [
    "guest",
    "housemate-1",
    "marlowe",
    "orphan-slug",
    "quill",
    "tibbs",
    "zephyrine",
  ]);
  assert.equal(t.includes("hosta"), false, "the admin is left out");
  assert.equal(t.includes("al"), false, "two-letter words never become terms");
  assert.equal(buildTerms(ROSTER, [], { exclude: ["quill"] }).includes("quill"), false);
});

test("whole words only, the database's rule: chamomile and cardamom pass", () => {
  assert.equal(hasWord("from-quill", "quill"), true);
  assert.equal(hasWord("Quill's", "quill"), true);
  assert.equal(hasWord("quilled pastry", "quill"), false);
  assert.equal(hasWord("cardamom", "carda"), false);
});

test("scrubString drops possessives and dedications, else says a friend", () => {
  assert.equal(scrubString("Quill's Lasagna", ["quill"]), "Lasagna");
  assert.equal(
    scrubString("Made for Marlowe on his birthday.", ["marlowe"]),
    "Made on his birthday.",
  );
  assert.equal(scrubString("Hosta and Tibbs liked it", ["tibbs"]), "Hosta and a friend liked it");
});

test("proposeEdit: tags carrying a name are removed, the id is left for a hand rename", () => {
  const r = proposeEdit(
    { id: "quills-lasagna", name: "Quill's Lasagna", tags: ["dinner", "from-quill"] },
    ["quill", "quills"],
  );
  assert.deepEqual(r.proposed.tags, ["dinner"]);
  assert.equal(r.proposed.name, "Lasagna");
  assert.equal(r.proposed.id, "quills-lasagna");
  assert.deepEqual(r.manual, ["id"]);
});

test("scanBank counts hits, near misses, and what still names someone", () => {
  const terms = ["marlowe", "quill"];
  const r = scanBank(
    [
      { path: "recipes/a.json", data: { id: "a", name: "Quill's soup", notes: "for Marlowe" } },
      { path: "recipes/b.json", data: { id: "b", name: "Quilled pastry" } },
    ],
    terms,
  );
  assert.equal(r.scanned, 2);
  assert.equal(r.hits, 2);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.nearMisses, 1);
  assert.equal(r.residual, 0);
});

test("CLI dry run: report and proposals land in --out, the clone is untouched, stdout is counts only", () => {
  const dir = clone();
  const out = mkdtempSync(join(tmpdir(), "bank-scrub-out-"));
  const before = readFileSync(join(dir, "recipes/quills-lasagna.json"), "utf8");
  /** @type {string[]} */
  const said = [];
  try {
    assert.equal(main([dir, "--out", out], { log: (s) => said.push(s), repoRoot: REPO }), 0);
    const printed = said.join("\n").toLowerCase();
    for (const name of [
      "quill",
      "marlowe",
      "tibbs",
      "zephyrine",
      "hosta",
      "lasagna",
      "orphan-slug",
    ]) {
      assert.equal(printed.includes(name), false, `stdout must not carry "${name}"`);
    }
    assert.match(printed, /4 bank files scanned/);
    assert.match(printed, /in 3 files/);
    assert.match(printed, /dry run/);
    assert.equal(
      readFileSync(join(dir, "recipes/quills-lasagna.json"), "utf8"),
      before,
      "dry run changes nothing",
    );
    const report = readFileSync(join(out, "report.md"), "utf8");
    assert.match(report, /PRIVATE/);
    assert.match(report, /recipes\/quills-lasagna\.json/);
    const proposed = JSON.parse(
      readFileSync(join(out, "proposed/recipes/quills-lasagna.json"), "utf8"),
    );
    assert.equal(proposed.name, "Lasagna");
    assert.deepEqual(proposed.tags, ["dinner"]);
    assert.equal(
      /marlowe|hosta/i.test(proposed.notes),
      true,
      "the admin's own name is not scrubbed",
    );
    assert.equal(/marlowe/i.test(proposed.notes), false);
    assert.ok(
      existsSync(join(out, "proposed/recipes-staging/tibbs-toast.json")),
      "staging is scanned too",
    );
    assert.equal(existsSync(join(out, "proposed/recipes/chamomile-tea.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("CLI --apply rewrites only the flagged files in the clone", () => {
  const dir = clone();
  const out = mkdtempSync(join(tmpdir(), "bank-scrub-out-"));
  try {
    main([dir, "--out", out, "--apply"], { log: () => {}, repoRoot: REPO });
    const r = JSON.parse(readFileSync(join(dir, "recipes/plain-dal.json"), "utf8"));
    assert.equal(/zephyrine/i.test(r.notes), false);
    const tea = readFileSync(join(dir, "recipes/chamomile-tea.json"), "utf8");
    assert.equal(
      tea,
      JSON.stringify({ id: "chamomile-tea", name: "Chamomile tea", notes: "cardamom optional" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("CLI refuses an --out inside this repo, and a folder that is not a clone", () => {
  const dir = clone();
  /** @type {string[]} */
  const said = [];
  try {
    assert.equal(
      main([dir, "--out", join(REPO, "scrub-out")], { log: (s) => said.push(s), repoRoot: REPO }),
      2,
    );
    assert.equal(existsSync(join(REPO, "scrub-out")), false);
    const empty = mkdtempSync(join(tmpdir(), "bank-scrub-empty-"));
    assert.equal(
      main([empty, "--out", join(tmpdir(), "x")], { log: (s) => said.push(s), repoRoot: REPO }),
      2,
    );
    rmSync(empty, { recursive: true, force: true });
    assert.equal(main([], { log: (s) => said.push(s), repoRoot: REPO }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
