import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

// The /annotate + /annotate-save HTTP handlers driven end to end through
// worker.fetch with a stubbed global fetch (same idea as vitals-ingest's
// harness): GitHub auth, the URL fetch, and the Anthropic calls are all
// canned, so CORS ordering, the informed retry, and the write path get real
// coverage without a network or a model.

const ORIGIN = "https://janniksin.github.io";
const ENV = { ANTHROPIC_API_KEY: "test-key" };

const SRC =
  "Beef Chili. Serves 4. Ingredients: 500 g ground beef, 1 onion, 2 cups black beans, " +
  "chili powder. Method: 1. Brown the beef in a pot. 2. Add onion and garlic and cook " +
  "down. 3. Simmer until thick and season to taste.";

const PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@type": "Recipe",
  name: "Beef Chili",
  recipeYield: "4 servings",
  recipeIngredient: ["500 g ground beef", "1 onion", "2 cups black beans", "chili powder"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Brown the beef in a pot." },
    { "@type": "HowToStep", text: "Add onion and garlic and cook down." },
    { "@type": "HowToStep", text: "Simmer until thick and season to taste." },
  ],
})}</script></head><body>life story</body></html>`;

/** a record_annotation input that validates green against SRC */
const goodAnnotation = () => ({
  mode: "annotated",
  objective: "taste",
  buckets: {
    technique: "isolated",
    precision: "several",
    sequence: "isolated",
    time: "none",
    ingredients: "isolated",
  },
  score: 70,
  riskGroups: false,
  sourceSteps: 3,
  sourceQuote: "Simmer until thick",
  allergensFound: [],
  title: "Beef Chili",
  servings: 4,
  totalTime: 60,
  mealType: "dinner",
  ingredients: [
    { food: "ground beef", grams: 500 },
    { food: "onion", grams: 150 },
    { food: "black beans", grams: 480 },
  ],
  steps: [
    {
      n: 1,
      title: "Brown",
      text: "Brown the beef hard, in batches, until crusted.",
      notes: [],
      temps: [{ label: "done-ground", unit: "C", fromSource: false, value: 0 }],
    },
    { n: 2, title: "Aromatics", text: "Cook the onion down, then the garlic.", notes: [], temps: [] },
    { n: 3, title: "Simmer", text: "Simmer gently, then season at the end.", notes: [], temps: [] },
  ],
  nutrition: { calories: 520, protein: 38, carbs: 40, fat: 20 },
  foodGroups: { beans: 1 },
  summary: ["everything in grams"],
});

const anthropicResponse = (/** @type {string} */ name, /** @type {any} */ input) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t", name, input }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Install a fetch stub. `annotations` is the queue of record_annotation
 * inputs returned by successive call-2 invocations.
 * @param {any[]} annotations
 */
function stubFetch(annotations) {
  const calls = { anthropic: 0, ghWrites: /** @type {any[]} */ ([]) };
  const real = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (/** @type {any} */ input, /** @type {any} */ init) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/JannikSin/mise-data/contents/")) {
      if (init?.method === "PUT") {
        calls.ghWrites.push({ url, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.anthropic++;
      const body = JSON.parse(init.body);
      const tool = body.tool_choice?.name;
      if (tool === "record_transcription") {
        return anthropicResponse("record_transcription", { text: SRC });
      }
      return anthropicResponse("record_annotation", annotations.shift() ?? goodAnnotation());
    }
    if (url.startsWith("https://recipes.example/")) {
      return new Response(PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

const post = (/** @type {string} */ path, /** @type {any} */ body, withAuth = true) =>
  worker.fetch(
    new Request(`https://mise-worker.test${path}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(withAuth ? { "x-mise-auth": "test-pat" } : {}),
      },
      body: JSON.stringify(body),
    }),
    ENV,
  );

test("CORS + auth ordering: 204 preflight, 403 bad origin, 404 unknown, 401 no token", async () => {
  const { restore } = stubFetch([]);
  try {
    const pre = await worker.fetch(
      new Request("https://mise-worker.test/annotate", {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      }),
      ENV,
    );
    assert.equal(pre.status, 204);

    const evil = await worker.fetch(
      new Request("https://mise-worker.test/annotate", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      }),
      ENV,
    );
    assert.equal(evil.status, 403);

    const nope = await post("/nope", {});
    assert.equal(nope.status, 404);

    const anon = await post("/annotate", {}, false);
    assert.equal(anon.status, 401);
  } finally {
    restore();
  }
});

test("/annotate URL path end to end: extract, two calls, validated result, save-eligible", async () => {
  const { calls, restore } = stubFetch([goodAnnotation()]);
  try {
    const res = await post("/annotate", {
      url: "https://recipes.example/chili",
      objective: "taste",
      diners: [],
      context: {},
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.result.mode, "annotated");
    assert.equal(data.result.score, 70);
    assert.equal(data.result.steps[0].temps[0].value, 71, "code supplied the number");
    assert.equal(data.path, "url");
    assert.equal(data.sourceUrl, "https://recipes.example/chili");
    assert.equal(data.saveEligible.ok, true);
    assert.ok(data.transcription.includes("Simmer until thick"));
    assert.equal(calls.anthropic, 2, "one transcribe + one annotate");
  } finally {
    restore();
  }
});

test("the retry is informed and bounded: bad then good = 200 after exactly 3 model calls", async () => {
  const { calls, restore } = stubFetch([{ ...goodAnnotation(), score: 62 }, goodAnnotation()]);
  try {
    const res = await post("/annotate", {
      url: "https://recipes.example/chili",
      objective: "taste",
      diners: [],
    });
    assert.equal(res.status, 200);
    assert.equal(calls.anthropic, 3, "transcribe + reject + informed retry");
  } finally {
    restore();
  }
});

test("two bad attempts = 422 error state, no recipe (H2)", async () => {
  const { calls, restore } = stubFetch([
    { ...goodAnnotation(), score: 62 },
    { ...goodAnnotation(), score: 55 },
  ]);
  try {
    const res = await post("/annotate", {
      url: "https://recipes.example/chili",
      objective: "taste",
      diners: [],
    });
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.ok(Array.isArray(data.details) && data.details.length > 0);
    assert.equal(calls.anthropic, 3);
  } finally {
    restore();
  }
});

test("an unconfirmed diner is refused server-side before any model call (C1 twin)", async () => {
  const { calls, restore } = stubFetch([]);
  try {
    const res = await post("/annotate", {
      url: "https://recipes.example/chili",
      objective: "taste",
      diners: [{ id: "mom", name: "Mom", unconfirmed: true, avoid: [] }],
    });
    assert.equal(res.status, 422);
    assert.equal(calls.anthropic, 0, "refused before spending a model call");
  } finally {
    restore();
  }
});

test("/annotate-save revalidates, refuses the photo path, and writes the canonical shape", async () => {
  const { calls, restore } = stubFetch([goodAnnotation()]);
  try {
    const scan = await post("/annotate", {
      url: "https://recipes.example/chili",
      objective: "taste",
      diners: [],
    });
    const data = await scan.json();

    const photo = await post("/annotate-save", { ...data, path: "photo", sourceUrl: data.sourceUrl });
    assert.equal(photo.status, 422, "photo path never saves in v1");

    const saved = await post("/annotate-save", {
      result: data.result,
      transcription: data.transcription,
      extracted: data.extracted,
      path: data.path,
      sourceUrl: data.sourceUrl,
      pantryStaples: ["chili powder"],
    });
    assert.equal(saved.status, 200);
    const { recipe } = await saved.json();
    assert.ok(recipe.id.startsWith("hbp-beef-chili-"));
    assert.equal(recipe.mealType, "dinner");
    assert.deepEqual(recipe.tags, ["hbp-annotated"]);
    assert.equal(calls.ghWrites.length, 1, "exactly one Contents API write");
    assert.equal(calls.ghWrites[0].url.includes("recipes/hbp-beef-chili-"), true);
    const written = JSON.parse(
      decodeURIComponent(escape(atob(calls.ghWrites[0].body.content))),
    );
    assert.equal(written.instructions[0].step, 1);
    assert.ok(written.instructions[0].text.includes("71 °C (done-ground)"));
    assert.equal(written.hbp.score, 70);
  } finally {
    restore();
  }
});
