// Mise 2.0 F2: /annotate-save for a signed-in caller writes AS THE CALLER
// (their own JWT to public.write_doc, with the publishable key, never the
// secret key), so the bank's admin-only rule and the name guard decide.
// The admin's save lands in the bank; anyone else's in their own recipes.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetGuestCachesForTests } from "../worker/src/index.js";
import { resetJwksCacheForTests } from "../worker/src/jwt.js";
import { resetAuthCachesForTests } from "../worker/src/auth.js";
import {
  makeKey,
  signJwt,
  fakeSupabase,
  fakeSvcDb,
  withFetch,
  workerReq,
  SANDBOX_ENV,
  SANDBOX_REF,
  USER_A,
  USER_B,
} from "./supabase-fakes.js";

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
})}</script></head><body>page</body></html>`;
const annotation = (title = "Beef Chili") => ({
  mode: "annotated",
  objective: "taste",
  buckets: { technique: "isolated", precision: "several", sequence: "isolated", time: "none", ingredients: "isolated" },
  score: 70,
  riskGroups: false,
  sourceSteps: 3,
  sourceQuote: "Simmer until thick",
  allergensFound: [],
  title,
  servings: 4,
  totalTime: 60,
  mealType: "dinner",
  ingredients: [
    { food: "ground beef", grams: 500 },
    { food: "onion", grams: 150 },
    { food: "black beans", grams: 480 },
  ],
  steps: [
    { n: 1, title: "Brown", text: "Brown the beef hard, in batches, until crusted.", notes: [], temps: [{ label: "done-ground", unit: "C", fromSource: false, value: 0 }] },
    { n: 2, title: "Aromatics", text: "Cook the onion down, then the garlic.", notes: [], temps: [] },
    { n: 3, title: "Simmer", text: "Simmer gently, then season at the end.", notes: [], temps: [] },
  ],
  nutrition: { calories: 520, protein: 38, carbs: 40, fat: 20 },
  foodGroups: { beans: 1 },
  summary: ["everything in grams"],
});
const tool = (/** @type {string} */ name, /** @type {any} */ input) =>
  Response.json({ content: [{ type: "tool_use", id: "t", name, input }] });

const ENV = { ...SANDBOX_ENV, ANTHROPIC_API_KEY: "sk-PLACEHOLDER" };

async function world(/** @type {string} */ title = "Beef Chili") {
  resetJwksCacheForTests();
  resetAuthCachesForTests();
  resetGuestCachesForTests();
  const db = fakeSvcDb({
    people: [
      { id: "p1", user: USER_A, slug: "host-1", admin: true, entitled: true, houses: ["house-w"] },
      { id: "p2", user: USER_B, slug: "housemate-1", entitled: true, houses: ["house-w"] },
    ],
  });
  const key = await makeKey("kid-1");
  let github = 0;
  const sb = fakeSupabase({
    jwks: { [SANDBOX_REF]: [key.jwk] },
    rpc: db.rpc,
    other: async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) github++;
      if (url.startsWith("https://api.anthropic.com/")) {
        const body = JSON.parse(init.body);
        return body.tool_choice?.name === "record_transcription"
          ? tool("record_transcription", { text: SRC })
          : tool("record_annotation", annotation(title));
      }
      if (url.startsWith("https://recipes.example/")) {
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { db, key, sb, gh: () => github };
}

/** scan, then save, as one caller */
async function scanAndSave(/** @type {string} */ jwt) {
  const scan = await worker.fetch(
    workerReq("/annotate", { url: "https://recipes.example/chili", objective: "taste", diners: [] }, { auth: jwt }),
    ENV,
  );
  assert.equal(scan.status, 200);
  const d = await scan.json();
  return worker.fetch(
    workerReq(
      "/annotate-save",
      { result: d.result, transcription: d.transcription, extracted: d.extracted, path: d.path, sourceUrl: d.sourceUrl, pantryStaples: [] },
      { auth: jwt },
    ),
    ENV,
  );
}

test("the admin's save goes to the bank through write_doc, as the admin", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_A });
    const r = await scanAndSave(jwt);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).saved, "bank");
    const write = w.db.st.writes[0];
    assert.match(write.path, /^recipes\/hbp-beef-chili-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(write.bearer, jwt, "the caller's own JWT, so RLS applies");
    assert.equal(write.apikey, "sb_publishable_PLACEHOLDER", "never the secret key");
    assert.equal(write.profile, "public");
  });
  assert.equal(w.gh(), 0, "no GitHub write");
});

test("anyone else's save goes to their own recipes", async () => {
  const w = await world();
  await withFetch(w.sb.fetchImpl, async () => {
    const r = await scanAndSave(await signJwt(w.key, { sub: USER_B }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).saved, "mine");
    assert.match(w.db.st.writes[0].path, /^profiles\/housemate-1\/recipes\/hbp-beef-chili-/);
  });
});

test("the name guard and a same-day duplicate answer plainly, and nothing else is written", async () => {
  const w = await world("Guest-name-term Chili");
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_A });
    const r = await scanAndSave(jwt);
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /names a person/);
  });
  const w2 = await world();
  await withFetch(w2.sb.fetchImpl, async () => {
    const jwt = await signJwt(w2.key, { sub: USER_A });
    assert.equal((await scanAndSave(jwt)).status, 200);
    const again = await scanAndSave(jwt);
    assert.equal(again.status, 409);
  });
});

test("with no publishable key the save refuses rather than fall back to the secret key", async () => {
  const w = await world();
  const env = { ...ENV, SUPABASE_SANDBOX_PUBLISHABLE_KEY: "" };
  await withFetch(w.sb.fetchImpl, async () => {
    const jwt = await signJwt(w.key, { sub: USER_A });
    const scan = await worker.fetch(
      workerReq("/annotate", { url: "https://recipes.example/chili", objective: "taste", diners: [] }, { auth: jwt }),
      env,
    );
    const d = await scan.json();
    const r = await worker.fetch(
      workerReq("/annotate-save", { result: d.result, transcription: d.transcription, extracted: d.extracted, path: d.path, sourceUrl: d.sourceUrl }, { auth: jwt }),
      env,
    );
    assert.equal(r.status, 502);
  });
  assert.equal(w.db.st.writes.length, 0);
});
