// THE GITHUB ADAPTER (Mise 2.0, plan section 5). The only module in app/ that
// imports github.js (tests/backend-import-guard.test.js). It wraps github.js
// UNCHANGED, so with this adapter selected every read, write, listing and
// stamp is byte-for-byte what Mise 1.95 did.
//
// The GitHub-only helpers the token and data-repo screens need (SYS, the
// boot check, the Worker client) are re-exported from here, so those callers
// keep working without importing github.js themselves. They go away with
// the GitHub lane, not before.

import {
  readFile,
  writeFile,
  listDir,
  getToken,
  checkDataRepo,
  tokenBroken,
  dataBranch,
} from "../github.js";

export {
  getToken,
  setToken,
  DATA_REPO,
  dataRepoOverridden,
  setDataRepo,
  tokenAgeDays,
  TOKEN_WARN_AGE_DAYS,
  checkDataRepo,
  tokenBroken,
  savingDead,
  dataBranch,
  branchProbe,
  readFile,
} from "../github.js";

/**
 * The GitHub backend. `stamp()` is the data branch (release train): the
 * stamp every cached and queued record carries, exactly as 1.95 wrote it.
 * @returns {import("../backend.js").Backend}
 */
export function createGithubAdapter() {
  return {
    name: "github",
    read: (path) => readFile(path),
    write: (path, data, sha) => writeFile(path, data, sha),
    list: (dir) => listDir(dir),
    async readMeta(path) {
      const got = await readFile(path);
      return got ? { sha: got.sha } : null;
    },
    async authHeader() {
      const token = getToken();
      return token ? `Bearer ${token}` : null;
    },
    status: () => checkDataRepo(),
    authBroken: (status) => tokenBroken(status),
    stamp: () => dataBranch(),
    laneOf: () => "github",
    session: () => null,
  };
}
