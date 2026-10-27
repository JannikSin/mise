// The typed failures a storage backend may throw (Mise 2.0, plan section 5).
// ConflictError stays in sync.js, where the merge-and-retry loop catches it;
// it is re-exported here so an adapter needs one import for all four.
//
//   ConflictError   P0409  stale sha or rev: merge and retry
//   ForbiddenError  P0403  this account may not write that file: refuse the record
//   NameGuardError  P0422  the write would show a name to another house: refuse it
//   AuthError       401    the session is gone or expired: stop, keep the queue

export { ConflictError } from "../sync.js";

export class ForbiddenError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`write forbidden: ${path}`);
    this.name = "ForbiddenError";
  }
}

export class NameGuardError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`write refused by the name guard: ${path}`);
    this.name = "NameGuardError";
  }
}

export class AuthError extends Error {
  /** @param {string} [what] */
  constructor(what = "not signed in") {
    super(`auth: ${what}`);
    this.name = "AuthError";
  }
}
