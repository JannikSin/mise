import test from "node:test";
import assert from "node:assert/strict";
import { parseHealthExport, mergeVitalsDays } from "../worker/src/lib.js";

// Health Auto Export's real payload shape: {"data":{"metrics":[...]}}
const hae = (metrics) => ({ data: { metrics } });

test("maps the six metrics the vitals dashboard renders", () => {
  const { days, recognized } = parseHealthExport(
    hae([
      {
        name: "step_count",
        units: "count",
        data: [{ date: "2026-08-03 00:00:00 -0500", qty: 8432 }],
      },
      {
        name: "walking_running_distance",
        units: "mi",
        data: [{ date: "2026-08-03 00:00:00 -0500", qty: 3.42 }],
      },
      {
        name: "active_energy",
        units: "kcal",
        data: [{ date: "2026-08-03 00:00:00 -0500", qty: 612.4 }],
      },
      {
        name: "resting_heart_rate",
        units: "bpm",
        data: [{ date: "2026-08-03 00:00:00 -0500", qty: 54.6 }],
      },
      {
        name: "heart_rate_variability",
        units: "ms",
        data: [{ date: "2026-08-03 00:00:00 -0500", qty: 61.27 }],
      },
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{ date: "2026-08-03 00:00:00 -0500", totalSleep: 7.34 }],
      },
    ]),
  );
  assert.equal(days.length, 1);
  assert.deepEqual(days[0], {
    date: "2026-08-03",
    steps: 8432,
    distanceMi: 3.4,
    activeKcal: 612,
    restingHR: 55,
    hrvMs: 61.3,
    sleepHours: 7.3,
  });
  assert.ok(recognized.includes("sleepHours"));
});

test("unknown metric names are reported, never silently dropped", () => {
  // This is the whole safety net: the exact HealthKit metric names are not
  // verified against a live export, so a name we do not know must surface in
  // the response rather than vanish and look like "the watch isn't working".
  const { days, ignored } = parseHealthExport(
    hae([
      { name: "step_count", units: "count", data: [{ date: "2026-08-03", qty: 500 }] },
      { name: "blood_oxygen_saturation", units: "%", data: [{ date: "2026-08-03", qty: 98 }] },
      { name: "some_future_metric", units: "x", data: [{ date: "2026-08-03", qty: 1 }] },
    ]),
  );
  assert.equal(days.length, 1);
  assert.deepEqual(ignored, ["blood_oxygen_saturation", "some_future_metric"]);
});

test("converts metric units, so a metric-locale phone does not write km into a miles field", () => {
  const { days } = parseHealthExport(
    hae([
      { name: "walking_running_distance", units: "km", data: [{ date: "2026-08-03", qty: 10 }] },
      { name: "active_energy", units: "kJ", data: [{ date: "2026-08-03", qty: 4184 }] },
    ]),
  );
  assert.equal(days[0].distanceMi, 6.2); // 10 km
  assert.equal(days[0].activeKcal, 1000); // 4184 kJ
});

test("sleep excludes inBed and awake, and falls back to summing stages", () => {
  // Time in bed is not sleep. Counting it inflates every downstream number,
  // and the health pipeline's whole point is that sleep is measured honestly.
  const { days } = parseHealthExport(
    hae([
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{ date: "2026-08-03", inBed: 9.5, awake: 0.8, deep: 1.2, core: 4.5, rem: 1.6 }],
      },
    ]),
  );
  assert.equal(days[0].sleepHours, 7.3); // 1.2 + 4.5 + 1.6, not 9.5
});

test("sleep in minutes or seconds is converted to hours", () => {
  // 444 min and 26,640 s are both 7.4 h. Deliberately not a value like 441 min
  // (7.35 h), which sits exactly on a rounding boundary where binary floats
  // make toFixed unpredictable. Sleep is stored to 0.1 h, so a half-boundary
  // is never worth defending in code for health data.
  const mins = parseHealthExport(
    hae([
      { name: "sleep_analysis", units: "min", data: [{ date: "2026-08-03", totalSleep: 444 }] },
    ]),
  );
  assert.equal(mins.days[0].sleepHours, 7.4);
  const secs = parseHealthExport(
    hae([
      { name: "sleep_analysis", units: "sec", data: [{ date: "2026-08-03", totalSleep: 26640 }] },
    ]),
  );
  assert.equal(secs.days[0].sleepHours, 7.4);
});

test("multi-day exports split into one row per date", () => {
  const { days } = parseHealthExport(
    hae([
      {
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-08-01 00:00:00 -0500", qty: 100 },
          { date: "2026-08-03 00:00:00 -0500", qty: 300 },
          { date: "2026-08-02 00:00:00 -0500", qty: 200 },
        ],
      },
    ]),
  );
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-08-01", "2026-08-02", "2026-08-03"],
  );
});

test("accepts a plain {days:[...]} body so the endpoint is curl-testable", () => {
  const { days } = parseHealthExport({
    days: [{ date: "2026-08-03", steps: 1234, sleepHours: 7 }],
  });
  assert.deepEqual(days, [{ date: "2026-08-03", steps: 1234, sleepHours: 7 }]);
});

test("garbage in gives zero days rather than a bad row", () => {
  assert.equal(parseHealthExport(null).days.length, 0);
  assert.equal(parseHealthExport({}).days.length, 0);
  assert.equal(parseHealthExport({ data: { metrics: "nope" } }).days.length, 0);
  // a zero-step day is a phone left on the nightstand, not a measurement
  assert.equal(
    parseHealthExport(
      hae([{ name: "step_count", units: "count", data: [{ date: "2026-08-03", qty: 0 }] }]),
    ).days.length,
    0,
  );
  // an unparseable date must not create a row keyed on junk
  assert.equal(
    parseHealthExport(
      hae([{ name: "step_count", units: "count", data: [{ date: "not-a-date", qty: 5 }] }]),
    ).days.length,
    0,
  );
});

test("merge upserts per FIELD, so a partial re-post never blanks earlier data", () => {
  const existing = [
    { date: "2026-08-01", steps: 100, sleepHours: 7 },
    { date: "2026-08-02", steps: 200, sleepHours: 8 },
  ];
  // a later post that only carries steps must not wipe 08-02's sleep
  const merged = mergeVitalsDays(existing, [{ date: "2026-08-02", steps: 250 }]);
  assert.deepEqual(merged, [
    { date: "2026-08-01", steps: 100, sleepHours: 7 },
    { date: "2026-08-02", steps: 250, sleepHours: 8 },
  ]);
});

test("merge appends new dates and keeps the list sorted oldest-first", () => {
  const merged = mergeVitalsDays(
    [{ date: "2026-08-05", steps: 1 }],
    [{ date: "2026-08-03", steps: 2 }],
  );
  assert.deepEqual(
    merged.map((d) => d.date),
    ["2026-08-03", "2026-08-05"],
  );
});

test("merge tolerates a missing or malformed existing file", () => {
  assert.deepEqual(mergeVitalsDays(null, [{ date: "2026-08-03", steps: 5 }]), [
    { date: "2026-08-03", steps: 5 },
  ]);
  assert.deepEqual(mergeVitalsDays([{ noDate: true }], []), []);
});

// ---- endpoint behaviour ---------------------------------------------------
// These call the Worker's fetch() directly. They prove the three things the
// unit tests above cannot: that /vitals survives the CORS gate with no Origin
// header (an iOS app sends none), that the key is actually enforced, and that
// a payload which parses to nothing fails loudly instead of returning 200.
// None of them reach GitHub, so they touch no real data.
import worker from "../worker/src/index.js";

const post = (path, body, headers = {}) =>
  new Request(`https://mise-worker.example.workers.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const ENV = { VITALS_KEY: "test-key-0123456789", MISE_DATA_WRITE_TOKEN: "ghp_fake" };

test("endpoint: a no-Origin post is NOT blocked by the CORS gate", async () => {
  // The regression that would break this silently: moving /vitals below
  // corsFor(). Health Auto Export is a native app and sends no Origin, so
  // every post would 403 and it would look like the watch was broken.
  const res = await worker.fetch(post("/vitals", { days: [] }), ENV);
  assert.notEqual(res.status, 403, "no-Origin post hit the browser CORS gate");
});

test("endpoint: rejects a missing or wrong key", async () => {
  assert.equal((await worker.fetch(post("/vitals", { days: [] }), ENV)).status, 401);
  assert.equal((await worker.fetch(post("/vitals/wrong-key", { days: [] }), ENV)).status, 401);
  assert.equal(
    (await worker.fetch(post("/vitals", { days: [] }, { "x-vitals-key": "nope" }), ENV)).status,
    401,
  );
});

test("endpoint: accepts the key in the header or in the path", async () => {
  // Both paths must get PAST auth. They then 422 on the empty payload, which
  // is the proof that auth passed rather than short-circuited.
  const viaHeader = await worker.fetch(
    post("/vitals", {}, { "x-vitals-key": ENV.VITALS_KEY }),
    ENV,
  );
  const viaPath = await worker.fetch(post(`/vitals/${ENV.VITALS_KEY}`, {}), ENV);
  assert.equal(viaHeader.status, 422);
  assert.equal(viaPath.status, 422);
});

test("endpoint: an unparseable payload 422s and names the metrics it ignored", async () => {
  // The important failure mode. A 200 here would mean the phone reports
  // success daily while the dashboard stays empty forever.
  const res = await worker.fetch(
    post(
      "/vitals",
      { data: { metrics: [{ name: "mystery_metric", data: [{ date: "2026-08-03", qty: 5 }] }] } },
      {
        "x-vitals-key": ENV.VITALS_KEY,
      },
    ),
    ENV,
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.deepEqual(body.ignored, ["mystery_metric"]);
});

test("endpoint: refuses to run before its secrets are set", async () => {
  const res = await worker.fetch(post("/vitals", { days: [] }), {});
  assert.equal(res.status, 503);
});

test("endpoint: GET is rejected", async () => {
  const res = await worker.fetch(
    new Request("https://mise-worker.example.workers.dev/vitals", { method: "GET" }),
    ENV,
  );
  assert.equal(res.status, 405);
});
