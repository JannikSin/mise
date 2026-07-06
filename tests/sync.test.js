import test from "node:test";
import assert from "node:assert/strict";
import { pushFile, afterPushRecord, ConflictError } from "../app/lib/sync.js";

// pushFile(io, job): flush one queued write to the data repo.
// io.read(path)  -> Promise<{ data, sha } | null>
// io.write(path, data, sha?) -> Promise<{ sha }>, throws ConflictError on 409.
// job: { path, data (local state), base (last known remote), sha }

/** Fake repo that behaves like the Contents API's sha check. */
function fakeRepo(initial) {
  const files = new Map(Object.entries(initial));
  let shaCounter = 0;
  return {
    files,
    io: {
      read: async (path) => {
        const f = files.get(path);
        return f ? { data: f.data, sha: f.sha } : null;
      },
      write: async (path, data, sha) => {
        const existing = files.get(path);
        if (existing && existing.sha !== sha) throw new ConflictError(path);
        if (!existing && sha) throw new ConflictError(path);
        const next = { data, sha: `sha-${++shaCounter}` };
        files.set(path, next);
        return { sha: next.sha };
      },
    },
  };
}

test("clean push writes local data and returns the new sha", async () => {
  const repo = fakeRepo({ "pantry.json": { data: { a: 1 }, sha: "sha-0" } });
  const result = await pushFile(repo.io, {
    path: "pantry.json",
    data: { a: 2 },
    base: { a: 1 },
    sha: "sha-0",
  });
  assert.deepEqual(result.data, { a: 2 });
  assert.equal(result.sha, "sha-1");
  assert.deepEqual(repo.files.get("pantry.json").data, { a: 2 });
});

test("push of a new file (no sha) creates it", async () => {
  const repo = fakeRepo({});
  const result = await pushFile(repo.io, {
    path: "plans/2026-W28.json",
    data: { week: "2026-W28", entries: [] },
    base: null,
    sha: null,
  });
  assert.equal(result.sha, "sha-1");
  assert.deepEqual(repo.files.get("plans/2026-W28.json").data, { week: "2026-W28", entries: [] });
});

test("409 conflict re-fetches, merges field-wise, and retries", async () => {
  // phone queued { a: 2 } while laptop already pushed { a: 1, b: 9 }
  const repo = fakeRepo({ "pantry.json": { data: { a: 1, b: 9 }, sha: "sha-laptop" } });
  const result = await pushFile(repo.io, {
    path: "pantry.json",
    data: { a: 2 },
    base: { a: 1 }, // phone's last known remote had no b
    sha: "sha-0", // stale
  });
  assert.deepEqual(result.data, { a: 2, b: 9 }); // both changes survive
  assert.deepEqual(repo.files.get("pantry.json").data, { a: 2, b: 9 });
});

test("conflict merge preserves both sides of a keyed array", async () => {
  const base = { staples: [{ id: "rice", onHand: true, runningLow: false }] };
  const remote = {
    staples: [
      { id: "rice", onHand: true, runningLow: false },
      { id: "saffron", onHand: true },
    ],
  };
  const local = { staples: [{ id: "rice", onHand: true, runningLow: true }] };
  const repo = fakeRepo({ "pantry.json": { data: remote, sha: "sha-remote" } });
  const result = await pushFile(repo.io, {
    path: "pantry.json",
    data: local,
    base,
    sha: "sha-stale",
  });
  assert.deepEqual(result.data, {
    staples: [
      { id: "rice", onHand: true, runningLow: true },
      { id: "saffron", onHand: true },
    ],
  });
});

test("repeated conflicts eventually throw instead of looping forever", async () => {
  const io = {
    read: async () => ({ data: { a: 1 }, sha: "always-new" }),
    write: async () => {
      throw new ConflictError("pantry.json");
    },
  };
  await assert.rejects(
    pushFile(io, { path: "pantry.json", data: { a: 2 }, base: { a: 1 }, sha: "s" }),
    ConflictError,
  );
});

// afterPushRecord(current, pushed, flushedRev): what to store after a push
// lands, given the record may have been edited again while the push was
// in flight. Never clears dirty on data the push didn't include.

test("afterPushRecord: untouched record is finalized clean", () => {
  const current = {
    path: "pantry.json",
    data: { a: 2 },
    base: { a: 1 },
    sha: "old",
    dirty: true,
    queuedAt: 5,
    rev: 3,
  };
  const rec = afterPushRecord(current, { data: { a: 2 }, sha: "new" }, 3);
  assert.deepEqual(rec, {
    path: "pantry.json",
    data: { a: 2 },
    base: { a: 2 },
    sha: "new",
    dirty: false,
    queuedAt: null,
    rev: 3,
  });
});

test("afterPushRecord: record edited mid-flight stays dirty with fresh base/sha", () => {
  const current = {
    path: "pantry.json",
    data: { a: 99 },
    base: { a: 1 },
    sha: "old",
    dirty: true,
    queuedAt: 5,
    rev: 4,
  };
  const rec = afterPushRecord(current, { data: { a: 2 }, sha: "new" }, 3);
  assert.equal(rec.dirty, true);
  assert.deepEqual(rec.data, { a: 99 }); // newer edit preserved
  assert.deepEqual(rec.base, { a: 2 }); // merge ancestor advanced to what's on GitHub
  assert.equal(rec.sha, "new");
  assert.equal(rec.rev, 4);
});

test("network failure propagates so the write stays queued", async () => {
  const io = {
    read: async () => null,
    write: async () => {
      throw new TypeError("fetch failed");
    },
  };
  await assert.rejects(
    pushFile(io, { path: "pantry.json", data: { a: 2 }, base: null, sha: null }),
    TypeError,
  );
});
