// gate20 loop 2, Red Team L2-1: one adapter.write is two requests (legacy
// read, then write_doc). A call hung past the lock deadline must not build its
// write_doc from the NEXT account's token. session-boot ties each adapter to
// its sign-in: once another account is adopted, the old adapter's token
// answers false and the call refuses (modelled here the same way).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeSupabase } from "./helpers/fake-supabase.js";
const { createSupabaseAdapter } = await import("../app/lib/backend/supabase-adapter.js");

test("adapter.write mid-call switch: write_doc uses the first account's token and house", async () => {
  const sb = fakeSupabase({});
  let who = { slug: "housemate-1", admin: false, home: "house-a" };
  let token = "tA";
  let adoption = 1;
  const mine = adoption;
  let stall = /** @type {any} */ (null);
  /** @type {any[]} */ const sent = [];
  const wrap = (/** @type {any} */ q, /** @type {string} */ label, /** @type {boolean} */ hang) => {
    let hdr = null;
    const b = { setHeader: (k, v) => { if (k === "Authorization") hdr = v; return b; },
      eq: (...a) => { q = q.eq(...a); return b; }, select: (...a) => { q = q.select(...a); return b; },
      maybeSingle: () => { q = q.maybeSingle(); return b; },
      then: async (ok, bad) => { if (hang) await new Promise((r) => (stall = r)); sent.push({ label, hdr }); return Promise.resolve(q).then(ok, bad); } };
    return b;
  };
  const client = {
    from: (t) => wrap(sb.client.from(t), `select ${t}`, true),
    rpc: (n, a) => wrap(sb.client.rpc(n, a), `rpc ${n} ${a?.p_path ?? ""}`, false),
  };
  const ad = createSupabaseAdapter({ client, session: () => who, accessToken: () => (adoption === mine ? token : false) });
  const p = ad.write("profiles/housemate-1/plans/2026-W40.json", { entries: [] }, "0123456789abcdef0123456789abcdef01234567").catch((e) => e);
  await new Promise((r) => setTimeout(r, 5));
  // the lock timed out; adopt(B) went on and set who and token
  who = { slug: "kin-9", admin: false, home: "house-b" };
  token = "tB";
  adoption++;
  stall();
  const result = await p;
  const w = sent.find((s) => s.label.startsWith("rpc write_doc"));
  assert.ok(!w || w.hdr === "Bearer tA", "write_doc never goes out as B");
  assert.ok(result instanceof Error, "the call refuses, so the record stays queued");
  
});
