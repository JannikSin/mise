// Conflict-safe push of one queued write (CLAUDE.md Part 2, rule 2):
// PUT with the last known sha; on 409 re-fetch, merge field-wise, retry.
import { mergeFieldWise } from "./merge.js";

export class ConflictError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`write conflict: ${path}`);
    this.name = "ConflictError";
  }
}

/**
 * @typedef {{
 *   read(path: string): Promise<{ data: Record<string, unknown>, sha: string } | null>,
 *   write(path: string, data: Record<string, unknown>, sha?: string | null): Promise<{ sha: string }>
 * }} SyncIO
 */

/**
 * @typedef {{
 *   path: string,
 *   data: Record<string, unknown>,
 *   base: Record<string, unknown> | null,
 *   sha: string | null,
 *   dirty: boolean,
 *   queuedAt: number | null,
 *   rev: number
 * }} StoredRecord
 */

/**
 * Decide what to persist after a push lands, given the record may have been
 * edited again while the push was in flight. If the record's rev advanced,
 * the newer local data stays dirty — only base/sha move forward, so the
 * next flush merges from the right ancestor. Never loses a mid-flight edit.
 * @param {StoredRecord | undefined} current
 * @param {{ data: Record<string, unknown>, sha: string }} pushed
 * @param {number} flushedRev
 * @returns {StoredRecord}
 */
export function afterPushRecord(current, pushed, flushedRev) {
  if (current && current.rev !== flushedRev) {
    return { ...current, base: pushed.data, sha: pushed.sha };
  }
  return {
    path: /** @type {StoredRecord} */ (current).path,
    data: pushed.data,
    base: pushed.data,
    sha: pushed.sha,
    dirty: false,
    queuedAt: null,
    rev: flushedRev,
  };
}

/**
 * @param {SyncIO} io
 * @param {{ path: string, data: Record<string, unknown>, base: Record<string, unknown> | null, sha: string | null }} job
 * @returns {Promise<{ data: Record<string, unknown>, sha: string }>}
 */
export async function pushFile(io, job) {
  const MAX_ATTEMPTS = 3;
  let { data, base, sha } = job;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await io.write(job.path, data, sha);
      return { data, sha: res.sha };
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw e;
      const remote = await io.read(job.path);
      data = mergeFieldWise(base ?? {}, data, remote?.data ?? {});
      base = remote?.data ?? {};
      sha = remote?.sha ?? null;
    }
  }
}
