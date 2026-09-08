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

// THE DATA BRANCH IS A FUNCTION OF ORIGIN (the release train, docs/RELEASE_TRAIN.md,
// Tribunal plan gate 2026-09-07). The live app on janniksin.github.io reads and
// writes the data repo's default branch exactly as it always has. The SANDBOX
// build on mise-next.pages.dev reads and writes the `sandbox` branch, and only
// when its index.html carries the committed meta with that value (the deploy
// swaps the value; a stale or hand-copied shell without it gets NO branch).
// Any other browser origin gets NO branch and every write is refused, so a
// session running the app on 127.0.0.1 cannot touch live data by forgetting a
// setting. There is deliberately no localStorage setting for this: a typed
// value is how the live install would end up pointed at the sandbox. Outside a
// browser (node tests, scripts) there is no origin and the default branch is
// assumed, which is what every existing caller expects.
const LIVE_ORIGIN = "https://janniksin.github.io";
const SANDBOX_ORIGIN = "https://mise-next.pages.dev";
const SANDBOX_BRANCH = "sandbox";

/**
 * The data-repo branch this install reads and writes: "main" on the live
 * origin (and outside a browser), "sandbox" on the sandbox origin when its
 * shell says so, null on every other origin (writes refused).
 * @returns {"main" | "sandbox" | null}
 */
export function dataBranch() {
  const loc = /** @type {any} */ (globalThis).location;
  const origin = loc && typeof loc.origin === "string" ? loc.origin : "";
  if (!origin || origin === "null") return "main";
  if (origin === LIVE_ORIGIN) return "main";
  if (origin === SANDBOX_ORIGIN) {
    const doc = /** @type {any} */ (globalThis).document;
    const meta =
      doc && typeof doc.querySelector === "function"
        ? (doc.querySelector('meta[name="mise-data-branch"]')?.getAttribute("content") ?? "").trim()
        : "";
    return meta === SANDBOX_BRANCH ? SANDBOX_BRANCH : null;
  }
  return null;
}

/**
 * Does the sandbox branch exist on the data repo? Only asked on the sandbox
 * build: a missing branch answers 404 to every read, which the cache-first
 * store would otherwise render as an empty kitchen and then write into.
 * @returns {Promise<"ok" | "missing" | "unknown" | "n/a">}
 */
export async function branchProbe() {
  const branch = dataBranch();
  if (branch !== SANDBOX_BRANCH) return "n/a";
  try {
    const res = await fetch(
      `${API}/repos/${DATA_REPO.owner}/${DATA_REPO.repo}/branches/${branch}`,
      { headers: authedHeaders() },
    );
    if (res.status === 404) return "missing";
    return res.ok ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

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
          authed.status === 403 && /rate limit|abuse|secondary/i.test(why)
            ? "throttled"
            : "invalid";
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
 * Is anything this device writes going to reach the kitchen? A broken token
 * is the loud case; a MISSING one was silent (David, 2026-09-06: an evening
 * of P+ taps on a device that had never been given the token, every row
 * vanished from the list as if saved, nothing reached the household pantry,
 * and the header showed only a small "N UNSAVED"). "missing" is the honest
 * state of a fresh install before SYS, so it only counts once there is
 * something waiting to leave.
 * @param {string | undefined} auth
 * @param {number} pending queued writes on this device
 * @returns {boolean}
 */
export function savingDead(auth, pending) {
  return tokenBroken(auth) || (auth === "missing" && pending > 0);
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
  const branch = dataBranch();
  if (branch === null) {
    // an origin the train does not know: reads may work, writes never do
    throw new Error(`write ${path}: unknown data branch for this origin, writes are refused`);
  }
  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: authedHeaders(),
    body: JSON.stringify({
      message: `mise: update ${path}`,
      content: toBase64(JSON.stringify(data, null, 2) + "\n"),
      ...(sha ? { sha } : {}),
      // the live build sends no branch at all (byte-identical to before the
      // train); only the sandbox names its branch
      ...(branch === SANDBOX_BRANCH ? { branch } : {}),
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

/**
 * The one builder of a Contents-API URL. The sandbox appends `?ref=sandbox`;
 * the live build's URL is byte-identical to before the train.
 * @param {string} path
 */
export function contentsUrl(path) {
  const base = `${API}/repos/${DATA_REPO.owner}/${DATA_REPO.repo}/contents/${path}`;
  return dataBranch() === SANDBOX_BRANCH ? `${base}?ref=${SANDBOX_BRANCH}` : base;
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
