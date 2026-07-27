import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_SESSIONS,
  coreStepAt,
  LEAD_IN,
  sessionForDay,
  sessionSeconds,
} from "../app/lib/core.js";

const STEPS = [
  { name: "Plank", seconds: 60, rest: 10, cue: "" },
  { name: "Side plank", side: /** @type {const} */ ("L"), seconds: 30, rest: 0, cue: "" },
  { name: "Side plank", side: /** @type {const} */ ("R"), seconds: 30, rest: 15, cue: "" },
  { name: "Hollow hold", seconds: 20, rest: 10, cue: "" },
];

test("coreStepAt walks work into rest and on to the next exercise", () => {
  assert.equal(coreStepAt(0, STEPS).phase, "work");
  assert.equal(coreStepAt(0, STEPS).step.name, "Plank");
  assert.equal(coreStepAt(0, STEPS).remaining, 60);
  assert.equal(coreStepAt(59, STEPS).remaining, 1);
  // rest after the plank, and it announces what is coming
  const resting = coreStepAt(60, STEPS);
  assert.equal(resting.phase, "rest");
  assert.equal(resting.remaining, 10);
  assert.equal(resting.next.side, "L");
  assert.equal(coreStepAt(70, STEPS).step.side, "L");
});

test("coreStepAt: rest 0 flows straight into the next exercise, no gap", () => {
  // left side runs 70-100; the right side must start at exactly 100
  assert.equal(coreStepAt(99, STEPS).step.side, "L");
  const next = coreStepAt(100, STEPS);
  assert.equal(next.phase, "work");
  assert.equal(next.step.side, "R");
  assert.equal(next.remaining, 30);
});

test("coreStepAt: the final rest never runs, the session just ends", () => {
  const total = sessionSeconds({ id: "t", name: "t", focus: "", note: "", steps: STEPS });
  // total counts the trailing 10s rest, but the clock finishes 10s earlier
  assert.equal(total, 175);
  assert.equal(coreStepAt(164, STEPS).phase, "work");
  assert.equal(coreStepAt(165, STEPS).phase, "done");
  assert.equal(coreStepAt(9999, STEPS).phase, "done");
});

test("coreStepAt: workLeft counts only work, and ignores rest", () => {
  // at t=0 every second of work is ahead: 60+30+30+20
  assert.equal(coreStepAt(0, STEPS).workLeft, 140);
  assert.equal(coreStepAt(30, STEPS).workLeft, 110);
  // during a rest, the finished step's work is already spent
  assert.equal(coreStepAt(60, STEPS).workLeft, 80);
});

test("coreStepAt: an empty session is immediately done, never NaN", () => {
  assert.equal(coreStepAt(0, []).phase, "done");
  assert.equal(coreStepAt(0, undefined).phase, "done");
  assert.equal(coreStepAt(-5, STEPS).phase, "work");
});

test("sessionForDay rotates across days and is stable within one", () => {
  const a = sessionForDay("2026-07-27");
  assert.equal(sessionForDay("2026-07-27").id, a.id);
  assert.notEqual(sessionForDay("2026-07-28").id, a.id);
  // every session is reachable across one full cycle
  const cycle = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"].map(
    (d) => sessionForDay(d).id,
  );
  assert.equal(new Set(cycle).size, CORE_SESSIONS.length);
});

test("every shipped session is floor-sized: 4-10 minutes, cued, side-balanced", () => {
  for (const s of CORE_SESSIONS) {
    const secs = sessionSeconds(s);
    assert.ok(secs >= 240 && secs <= 600, `${s.id} is ${secs}s, outside 4-10 min`);
    assert.ok(s.steps.length >= 4, `${s.id} has too few moves`);
    for (const step of s.steps) {
      assert.ok(step.cue.length > 10, `${s.id}/${step.name} has no usable cue`);
      assert.ok(step.seconds > 0 && step.rest >= 0, `${s.id}/${step.name} has bad timing`);
    }
    // a one-sided exercise must appear for BOTH sides, or it builds an imbalance
    const sided = s.steps.filter((x) => x.side);
    const byName = new Map();
    for (const x of sided) byName.set(x.name, (byName.get(x.name) ?? "") + x.side);
    for (const [name, sides] of byName) {
      assert.equal([...sides].sort().join(""), "LR", `${s.id}/${name} is not side-balanced`);
    }
  }
});

test("coreStepAt: the GET READY lead-in runs before move one, then shifts everything", () => {
  const ready = coreStepAt(0, STEPS, 8);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.remaining, 8);
  // it previews what is coming, so the cue and figure are on screen early
  assert.equal(ready.next.name, "Plank");
  assert.equal(ready.step, null);
  assert.equal(coreStepAt(7, STEPS, 8).phase, "ready");
  // the session proper starts the instant the lead-in ends, undrifted
  const first = coreStepAt(8, STEPS, 8);
  assert.equal(first.phase, "work");
  assert.equal(first.step.name, "Plank");
  assert.equal(first.remaining, 60);
  // and the whole session shifts by exactly the lead-in, no more
  assert.equal(coreStepAt(165 + 8, STEPS, 8).phase, "done");
  assert.equal(coreStepAt(164 + 8, STEPS, 8).phase, "work");
});

test("coreStepAt: no lead-in argument behaves exactly as before", () => {
  assert.equal(coreStepAt(0, STEPS).phase, "work");
  assert.equal(coreStepAt(0, STEPS, 0).phase, "work");
  assert.ok(LEAD_IN > 0 && LEAD_IN <= 15);
});

test("every shipped exercise has a figure, so no move ships undrawn", async () => {
  // the figure module imports htm/preact, which node cannot resolve, so match
  // the exported table against the sessions by reading the source instead
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../app/views/core-figure.js", import.meta.url), "utf8"),
  );
  const patterns = [...src.matchAll(/\[\/(.+?)\/i,\s*"([a-z]+)"\]/g)].map(([, re]) => new RegExp(re, "i"));
  assert.ok(patterns.length >= 10, "figure table did not parse");
  const names = [...new Set(CORE_SESSIONS.flatMap((s) => s.steps.map((x) => x.name)))];
  for (const name of names) {
    assert.ok(
      patterns.some((re) => re.test(name)),
      `"${name}" has no figure — add one to core-figure.js or the session ships a move nobody can see`,
    );
  }
});
