import test from "node:test";
import assert from "node:assert/strict";
import {
  lastSetsFor,
  personalRecords,
  seriesFor,
  upsertDay,
  addSetToSession,
  formatSets,
} from "../app/lib/fitness.js";

const SESSIONS = [
  {
    date: "2026-06-29",
    templateId: "chest-triceps",
    exercises: [{ name: "Bench Press", sets: [{ weight: 150, reps: 5 }] }],
  },
  {
    date: "2026-07-03",
    templateId: "chest-triceps",
    exercises: [
      {
        name: "Bench Press",
        sets: [
          { weight: 155, reps: 5 },
          { weight: 155, reps: 4 },
        ],
      },
      { name: "Dips", sets: [{ weight: 0, reps: 12 }] },
    ],
  },
];

test("lastSetsFor returns the most recent session's sets for a lift", () => {
  assert.deepEqual(lastSetsFor(SESSIONS, "Bench Press"), [
    { weight: 155, reps: 5 },
    { weight: 155, reps: 4 },
  ]);
  assert.equal(lastSetsFor(SESSIONS, "Squat"), null);
});

test("formatSets renders console-style last-time numbers", () => {
  assert.equal(
    formatSets([
      { weight: 155, reps: 5 },
      { weight: 155, reps: 4 },
    ]),
    "155×5 · 155×4",
  );
  assert.equal(formatSets([{ weight: 0, reps: 12 }]), "bw×12");
});

test("personalRecords finds the heaviest set per lift", () => {
  const prs = personalRecords(SESSIONS);
  assert.deepEqual(prs.get("Bench Press"), { weight: 155, reps: 5, date: "2026-07-03" });
  assert.deepEqual(prs.get("Dips"), { weight: 0, reps: 12, date: "2026-07-03" });
});

test("seriesFor returns date-sorted top weight per session for charting", () => {
  assert.deepEqual(seriesFor(SESSIONS, "Bench Press"), [
    { date: "2026-06-29", top: 150 },
    { date: "2026-07-03", top: 155 },
  ]);
  assert.deepEqual(seriesFor(SESSIONS, "Squat"), []);
});

test("upsertDay patches an existing day without touching others", () => {
  const daily = { days: [{ date: "2026-07-05", sleepHours: 8 }] };
  const next = upsertDay(daily, "2026-07-05", { weight: 180.5 });
  assert.deepEqual(next.days, [{ date: "2026-07-05", sleepHours: 8, weight: 180.5 }]);
  assert.deepEqual(daily.days, [{ date: "2026-07-05", sleepHours: 8 }], "no mutation");
});

test("upsertDay creates the day when absent", () => {
  const next = upsertDay({ days: [] }, "2026-07-06", { pushups: 40 });
  assert.deepEqual(next.days, [{ date: "2026-07-06", pushups: 40 }]);
});

test("addSetToSession appends to the right exercise, creating it on first set", () => {
  let s = { date: "2026-07-06", templateId: "legs", exercises: [] };
  s = addSetToSession(s, "Squat", { weight: 185, reps: 5 });
  s = addSetToSession(s, "Squat", { weight: 185, reps: 5 });
  s = addSetToSession(s, "Leg Press", { weight: 300, reps: 10 });
  assert.equal(s.exercises.length, 2);
  assert.equal(s.exercises[0].sets.length, 2);
  assert.deepEqual(s.exercises[1], { name: "Leg Press", sets: [{ weight: 300, reps: 10 }] });
});
