// GitHub access layer. The ONLY module that talks to api.github.com.
// Views import from here (or, later, from store.js) — never fetch directly.

import { ConflictError } from "./sync.js";

const API = "https://api.github.com";
// B4 (friend groups): each install can point at its OWN private data repo.
// "owner/repo" in localStorage; absent = the family default. Getters keep
// every existing DATA_REPO.owner/.repo call site working unchanged.
const REPO_KEY = "mise.dataRepo";
const DEFAULT_REPO = { owner: "JannikSin", repo: "mise-data" };
function parseRepo() {
  try {
    const raw = (localStorage.getItem(REPO_KEY) ?? "").trim();
    const m = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
    return m ? { owner: m[1], repo: m[2] } : DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}
export const DATA_REPO = {
  get owner() {
    return parseRepo().owner;
  },
  get repo() {
    return parseRepo().repo;
  },
};

/** @returns {boolean} true when this install points at a non-default repo */
export function dataRepoOverridden() {
  try {
    return Boolean(localStorage.getItem(REPO_KEY));
  } catch {
    return false;
  }
}

/**
 * Point this install at another private data repo ("owner/repo"; blank =
 * back to the family default). The caller MUST wipe local state and reload:
 * cached data from the previous repo must never bleed into the next one.
 * @param {string} v
 */
export function setDataRepo(v) {
  const clean = (v ?? "").trim();
  if (clean && !/^[\w.-]+\/[\w.-]+$/.test(clean)) return false;
  if (clean) localStorage.setItem(REPO_KEY, clean);
  else localStorage.removeItem(REPO_KEY);
  return true;
}
const TOKEN_KEY = "mise.pat";

/** @returns {string | null} */
export function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  // lazy backfill: tokens saved before the savedAt stamp existed start their
  // age clock now — slightly late is survivable (the invalid-token renewal
  // card is the backstop); NEVER warning is not
  if (token && !localStorage.getItem(`${TOKEN_KEY}.savedAt`)) {
    localStorage.setItem(`${TOKEN_KEY}.savedAt`, new Date().toISOString());
  }
  return token;
}

/** @param {string} token */
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token.trim());
  // fine-grained PATs are created with 1-year expiry (setup ceremony);
  // the save date drives the renew-soon warning (blueprint §4.5)
  localStorage.setItem(`${TOKEN_KEY}.savedAt`, new Date().toISOString());
}

/**
 * Days since the token was saved on this device; null if unknown (token
 * predates this feature or was never saved here).
 * @returns {number | null}
 */
export function tokenAgeDays() {
  const saved = localStorage.getItem(`${TOKEN_KEY}.savedAt`);
  if (!saved) return null;
  const ms = Date.now() - new Date(saved).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

/** Warn two weeks before the assumed 1-year expiry. */
export const TOKEN_WARN_AGE_DAYS = 351;

/**
 * Data-repo safety check (CLAUDE.md Part 2, rule 1).
 *
 * Privacy probe is UNAUTHENTICATED on purpose: a 200 means the repo is
 * publicly visible (alarm); 404 means private-or-missing (expected). The
 * authenticated call then verifies the token actually reaches the repo.
 *
 * @returns {Promise<{
 *   privacy: "private" | "PUBLIC" | "unknown",
 *   auth: "ok" | "invalid" | "norepo" | "throttled" | "missing" | "unknown",
 *   reachable: boolean
 * }>}
 */
export async function checkDataRepo() {
  const url = `${API}/repos/${DATA_REPO.owner}/${DATA_REPO.repo}`;

  let reachable = true;
  /** @type {"private" | "PUBLIC" | "unknown"} */
  let privacy;
  try {
    const anon = await fetch(url, { headers: baseHeaders() });
    privacy = anon.status === 404 ? "private" : anon.ok ? "PUBLIC" : "unknown";
  } catch {
    privacy = "unknown"; // offline — cache decides what to show
    reachable = false;
  }

  const token = getToken();
  /** @type {"ok" | "invalid" | "norepo" | "throttled" | "missing" | "unknown"} */
  let auth = "missing";
  if (token) {
    try {
      const authed = await fetch(url, { headers: baseHeaders(token) });
      if (authed.ok) {
        auth = "ok";
        const repo = await authed.json();
        if (repo.private === true) privacy = "private";
        else if (repo.private === false) privacy = "PUBLIC";
      } else if (authed.status === 404) {
        // the token authenticated but the repo is not in its selected-
        // repositories list — a scope mistake, NOT a dead token. Telling him
        // "invalid" sends him off minting new tokens with the same default
        // ("Public repositories") and the same 404 forever.
        auth = "norepo";
      } else {
        // A 403 is TWO different things wearing one status code: "this token
        // may not do that" and "you are going too fast". Sending someone to
        // regenerate a perfectly good token because they were rate-limited is
        // the same class of wrong instruction as the norepo case, so read
        // GitHub's own words before deciding which to say.
        let why = "";
        try {
          const body = /** @type {any} */ (await authed.json());
          why = typeof body?.message === "string" ? body.message : "";
        } catch {
          // a non-JSON error body just means we fall through to "invalid"
        }
        auth =
          authed.status === 403 && /rate limit|abuse|secondary/i.test(why) ? "throttled" : "invalid";
      }
    } catch {
      auth = "unknown"; // offline
      reachable = false;
    }
  }

  return { privacy, auth, reachable };
}

/**
 * A saved token that cannot reach the data repo, for whatever reason. Every
 * view gates on this, not on a single auth value — "invalid" and "norepo"
 * both mean nothing syncs, and a view that only checks one lets the other
 * render as if all is well.
 * @param {string | undefined} auth
 */
export function tokenBroken(auth) {
  // "throttled" is deliberately NOT here: nothing is wrong with the token and
  // it fixes itself, so it must not raise a fix-your-credentials alarm.
  return auth === "invalid" || auth === "norepo";
}

/**
 * Read one JSON file from the data repo via the Contents API.
 * @param {string} path
 * @returns {Promise<{ data: Record<string, unknown>, sha: string } | null>} null = file absent
 */
export async function readFile(path) {
  const res = await fetch(contentsUrl(path), { headers: authedHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${path}: HTTP ${res.status}`);
  const json = await res.json();
  // directories come back as arrays; >1MB files omit content — neither is
  // a valid Mise data file (small per-domain JSON only)
  if (Array.isArray(json) || typeof json.content !== "string") {
    throw new Error(`read ${path}: not a small JSON file`);
  }
  return { data: JSON.parse(fromBase64(json.content)), sha: json.sha };
}

/**
 * Write one JSON file via the Contents API. Always pass the last known sha
 * for existing files (CLAUDE.md Part 2, rule 2); a sha mismatch throws
 * ConflictError so the sync layer can merge and retry.
 * @param {string} path
 * @param {Record<string, unknown>} data
 * @param {string | null} [sha]
 * @returns {Promise<{ sha: string }>}
 */
export async function writeFile(path, data, sha) {
  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: authedHeaders(),
    body: JSON.stringify({
      message: `mise: update ${path}`,
      content: toBase64(JSON.stringify(data, null, 2) + "\n"),
      ...(sha ? { sha } : {}),
    }),
  });
  // 409 = sha stale/branch moved → merge and retry. 422 is a conflict ONLY
  // for sha-less creates racing an existing file; with a sha it's a real
  // validation error that must surface, not be retried forever as a merge.
  if (res.status === 409 || (res.status === 422 && !sha)) throw new ConflictError(path);
  if (!res.ok) {
    // Carry GitHub's own words. A 403 is BOTH "your token may not write here"
    // and "you are being secondary-rate-limited", and the sync layer cannot
    // tell a permanent failure from a wait-and-retry one without the message.
    let detail = "";
    try {
      const body = /** @type {any} */ (await res.json());
      detail = typeof body?.message === "string" ? ` ${body.message}` : "";
    } catch {
      // a non-JSON error body is not worth failing the failure over
    }
    throw new Error(`write ${path}: HTTP ${res.status}${detail}`);
  }
  const json = await res.json();
  return { sha: json.content.sha };
}

/**
 * List the JSON files of a directory in the data repo.
 * @param {string} dir
 * @returns {Promise<{ name: string, path: string, sha: string }[]>} [] if the dir is absent
 */
export async function listDir(dir) {
  const res = await fetch(contentsUrl(dir), { headers: authedHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list ${dir}: HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`list ${dir}: not a directory`);
  return json
    .filter((e) => e.type === "file" && e.name.endsWith(".json"))
    .map((e) => ({ name: e.name, path: e.path, sha: e.sha }));
}

/** @param {string} path */
function contentsUrl(path) {
  return `${API}/repos/${DATA_REPO.owner}/${DATA_REPO.repo}/contents/${path}`;
}

/** @returns {Record<string, string>} */
function authedHeaders() {
  const token = getToken();
  if (!token) throw new Error("no token set");
  return baseHeaders(token);
}

/** @param {string} s */
function toBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** @param {string} b64 */
function fromBase64(b64) {
  const bin = atob(b64.replaceAll("\n", ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * @param {string} [token]
 * @returns {Record<string, string>}
 */
function baseHeaders(token) {
  /** @type {Record<string, string>} */
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
