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
  buildTermSet,
  gitAbove,
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

test("terms come from the clone's roster and folders through name-guard's termWords, never the admin's", () => {
  const t = buildTerms(ROSTER, ["quill", "orphan-slug", "host-1"]);
  assert.deepEqual(t, [
    "al",
    "alb",
    "guest",
    "guestquill",
    "housemate",
    "marlowe",
    "marlowetibbs",
    "orphan",
    "orphanslug",
    "quill",
    "slug",
    "tibbs",
    "zephyrine",
  ]);
  assert.equal(t.includes("hosta"), false, "the admin is left out");
  assert.equal(t.includes("al"), true, "a two-letter name is a term (review only, never auto-edited)");
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

test("proposeEdit: a tag carrying a name is left for review, the id is left for a hand rename", () => {
  const r = proposeEdit(
    { id: "quills-lasagna", name: "Quill's Lasagna", tags: ["dinner", "from-quill"] },
    ["quill"],
  );
  assert.deepEqual(r.proposed.tags, ["dinner", "from-quill"]);
  assert.ok(r.review.some((v) => v.at === "tags[1]"));
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
    assert.deepEqual(proposed.tags, ["dinner", "from-quill"], "tags are never edited");
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

// ---- fix loop 1, item 2 (Red Team R2, Engineer F2, F17, F18): the scrub
// edits only name, notes, description and instructions[].text, sends food
// words and 2-letter names to review, reads decoded and folded text with the
// shared name-guard, and keeps a surname shared with the admin as a term.
const FOOD_ROSTER = {
  profiles: [
    { id: "host-1", name: "Hosta Admin", admin: true },
    { id: "ginger", name: "Ginger Example", household: "house-w" },
    { id: "zoe", name: "Zoë Q", household: "house-w" },
    { id: "jo", name: "Jo Q", household: "house-w" },
  ],
};
const STIR_FRY = {
  id: "stir-fry",
  name: "Ginger stir fry",
  ingredients: [{ item: "fresh ginger", qty: "20 g", note: "for Zoë, peeled" }, { item: "sesame oil" }],
  allergens: ["ginger"],
  tags: ["ginger", "dinner"],
  nutrition: { calories: 400 },
  notes: "Zoë's favourite; Jo loves it",
  instructions: [{ step: 1, text: "Fry the ginger with Zoe for 2 minutes." }],
};

test("R2 probe: a food-word name never touches ingredients, allergens, tags or the dish name", () => {
  const terms = buildTerms(FOOD_ROSTER, ["ginger", "zoe", "jo"]);
  const e = proposeEdit(STIR_FRY, terms);
  assert.deepEqual(e.proposed.ingredients, STIR_FRY.ingredients, "ingredients untouched, even a note naming someone");
  assert.deepEqual(e.proposed.allergens, ["ginger"], "the allergy screen keeps its food word");
  assert.deepEqual(e.proposed.tags, ["ginger", "dinner"]);
  assert.equal(e.proposed.name, "Ginger stir fry", "a food word is never auto-replaced");
  assert.ok(e.review.some((v) => v.at === "name" && v.word === "ginger" && v.why === "food word"));
  assert.ok(e.review.some((v) => v.at === "ingredients[0].note" && v.word === "zoe"));
});

test("R2: accented names match their plain spelling; a 2-letter name goes to review, not auto", () => {
  const terms = buildTerms(FOOD_ROSTER, []);
  assert.ok(terms.includes("zoe"));
  assert.ok(terms.includes("jo"));
  assert.equal(hasWord("Zoë's favourite", "zoe"), true);
  const e = proposeEdit({ id: "x", notes: "Zoë's favourite" }, terms);
  assert.equal(e.proposed.notes, "Favourite", "the accented possessive is dropped in place");
  const j = proposeEdit({ id: "x", notes: "Jo loves it" }, terms);
  assert.equal(j.proposed.notes, "Jo loves it", "2 letters: never auto-edited");
  assert.ok(j.review.some((v) => v.word === "jo" && v.why === "short name"));
  // a field mixing an auto name with a review-only one is left whole
  const mixed = proposeEdit({ id: "x", notes: STIR_FRY.notes }, terms);
  assert.equal(mixed.proposed.notes, STIR_FRY.notes);
});

test("R2: instructions are edited for a whole-word name, but a dedication is replaced, never dropped", () => {
  const e = proposeEdit({ id: "x", instructions: [{ step: 1, text: "Stir with Marlowe for 2 minutes." }] }, ["marlowe"]);
  assert.equal(e.proposed.instructions[0].text, "Stir with a friend for 2 minutes.");
  const n = proposeEdit({ id: "x", notes: "Made with Marlowe." }, ["marlowe"]);
  assert.equal(n.proposed.notes, "Made.");
  const step = proposeEdit({ id: "x", instructions: [{ step: 1, text: "Fry the ginger with Zoe." }] }, ["ginger", "zoe"]);
  assert.equal(step.proposed.instructions[0].text, "Fry the ginger with Zoe.", "a food-word name in the step: review");
});

test("E2: a name right after a newline or a tab is found (decoded text, never JSON text)", () => {
  const files = [{ path: "recipes/a.json", data: { id: "a", notes: "Serves 4.\nSam loves it", description: "x\tSam" } }];
  const r = scanBank(files, ["sam"]);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.hits, 2);
  assert.equal(r.flagged[0].proposed.notes, "Serves 4.\na friend loves it");
  assert.equal(r.residual, 0);
});

test("the residual is the migration guard's own answer: a name the tool may not edit still counts", () => {
  const r = scanBank([{ path: "recipes/b.json", data: { id: "b", ingredients: [{ item: "rice", note: "Marlowe's way" }] } }], ["marlowe"]);
  assert.equal(r.residual, 1);
  assert.equal(r.flagged[0].changes.length, 0);
  assert.ok(r.flagged[0].review.length > 0);
  // a name split across two list items is seen by the guard, so it is listed
  const s = scanBank([{ path: "recipes/c.json", data: { id: "c", tags: ["marl", "owe"] } }], ["marlowe"]);
  assert.equal(s.residual, 1);
  assert.ok(s.flagged[0].review.some((v) => v.why === "split across two list items"));
});

test("F17: a surname shared with the admin stays a term (the migration's gate refuses it too)", () => {
  const roster = {
    profiles: [
      { id: "host-1", name: "Hosta Tibbs", admin: true },
      { id: "housemate-1", name: "Marlowe Tibbs" },
    ],
  };
  const t = buildTerms(roster, []);
  assert.ok(t.includes("tibbs"));
  assert.equal(t.includes("hosta"), false);
});

test("F17: --people adds the migration's guard terms and extra names; an unreadable one is named by field only", () => {
  const people = {
    admin: "host-1",
    people: [
      { slug: "host-1", names: ["Hostname"] },
      { slug: "housemate-1", names: ["Nickname-a", "Женя"] },
    ],
    guardTerms: [{ term: "Quarry Lane", hiddenFrom: "house-f" }],
  };
  const r = buildTermSet({ profiles: [] }, [], { people });
  assert.ok(r.words.includes("nickname"));
  assert.ok(r.words.includes("quarry") && r.words.includes("lane"));
  assert.equal(r.words.includes("hostname"), false, "the admin's own names are not terms");
  assert.deepEqual(r.unusable, ["people people[1].names[1]"]);
  // the CLI prints the field, never the value
  const dir = clone();
  const out = mkdtempSync(join(tmpdir(), "bank-scrub-out-"));
  const pf = join(out, "people.local.json");
  writeFileSync(pf, JSON.stringify(people));
  /** @type {string[]} */
  const said = [];
  try {
    assert.equal(main([dir, "--out", out, "--people", pf], { log: (s) => said.push(s), repoRoot: REPO }), 0);
    const printed = said.join("\n");
    assert.match(printed, /people people\[1\]\.names\[1\]/);
    assert.equal(/Ж|nickname|quarry/i.test(printed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("R2: --apply never writes a file whose only hits are review items", () => {
  const dir = clone();
  const out = mkdtempSync(join(tmpdir(), "bank-scrub-out-"));
  const p = join(dir, "recipes", "ginger-rice.json");
  writeFileSync(p, JSON.stringify({ id: "ginger-rice", name: "Rice", ingredients: [{ food: "ginger" }], allergens: ["ginger"] }));
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ profiles: [...ROSTER.profiles, { id: "gin", name: "Ginger Q" }] }));
  const before = readFileSync(p, "utf8");
  try {
    main([dir, "--out", out, "--apply"], { log: () => {}, repoRoot: REPO });
    assert.equal(readFileSync(p, "utf8"), before);
    assert.match(readFileSync(join(out, "report.md"), "utf8"), /Hand review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("R3: --out is refused inside ANY git working copy, not only this repo", () => {
  const dir = clone();
  const other = mkdtempSync(join(tmpdir(), "bank-scrub-otherrepo-"));
  mkdirSync(join(other, ".git"));
  /** @type {string[]} */
  const said = [];
  try {
    const target = join(other, "deep", "scrub");
    assert.equal(main([dir, "--out", target], { log: (s) => said.push(s), repoRoot: REPO }), 2);
    assert.match(said.join("\n"), /git working copy/);
    assert.equal(existsSync(target), false, "nothing written there");
    assert.equal(gitAbove(target), other);
    // a .git FILE (a worktree's pointer) counts too
    const wt = mkdtempSync(join(tmpdir(), "bank-scrub-wt-"));
    writeFileSync(join(wt, ".git"), "gitdir: elsewhere");
    assert.equal(main([dir, "--out", join(wt, "x")], { log: () => {}, repoRoot: REPO }), 2);
    rmSync(wt, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
