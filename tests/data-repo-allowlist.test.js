import test from "node:test";
import assert from "node:assert/strict";
import { allowedRepos, repoForRequest } from "../worker/src/index.js";

// B4 (friend groups): the client has been able to point an install at its own
// private data repo since B4 landed, but the Worker hard-coded one repo, so
// such an install synced fine and got 401 on every AI endpoint. That was the
// roommate's blocker. Opening it up is only safe because of the allowlist,
// so the allowlist is what these tests are about.

const req = (repo) =>
  new Request("https://w/scan", {
    method: "POST",
    headers: repo ? { "x-mise-repo": repo } : {},
  });

test("with no config, only the family repo is allowed", () => {
  assert.deepEqual(allowedRepos({}), ["janniksin/mise-data"]);
  assert.deepEqual(allowedRepos({ MISE_DATA_REPOS: "" }), ["janniksin/mise-data"]);
});

test("an unlisted repo silently falls back — it never buys access", () => {
  // THE WHOLE DEFENCE. isAuthorized only proves the caller can see a private
  // repo; without this, presenting a token for any private repo you happen to
  // own would spend David's Anthropic key.
  assert.equal(repoForRequest(req("someone/their-private-repo"), {}), "JannikSin/mise-data");
  assert.equal(repoForRequest(req("JannikSin/mise"), {}), "JannikSin/mise-data");
});

test("an absent header behaves exactly as before", () => {
  // every existing install ships no header, so this change must be a no-op
  assert.equal(repoForRequest(req(null), {}), "JannikSin/mise-data");
});

test("an allowlisted repo is honoured, case-insensitively", () => {
  const env = { MISE_DATA_REPOS: "roommate/mise-data" };
  assert.equal(repoForRequest(req("roommate/mise-data"), env), "roommate/mise-data");
  assert.equal(repoForRequest(req("RoomMate/Mise-Data"), env), "roommate/mise-data");
});

test("garbage in the allowlist is dropped, not trusted", () => {
  const env = { MISE_DATA_REPOS: "not-a-repo, ../../etc/passwd, ok/one," };
  assert.deepEqual(allowedRepos(env), ["janniksin/mise-data", "ok/one"]);
  assert.equal(repoForRequest(req("not-a-repo"), env), "JannikSin/mise-data");
});
