// GitHub access layer. The ONLY module that talks to api.github.com.
// Views import from here (or, later, from store.js) — never fetch directly.

import { ConflictError } from "./sync.js";

const API = "https://api.github.com";
export const DATA_REPO = { owner: "JannikSin", repo: "mise-data" };
const TOKEN_KEY = "mise.pat";

/** @returns {string | null} */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** @param {string} token */
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Data-repo safety check (CLAUDE.md Part 2, rule 1).
 *
 * Privacy probe is UNAUTHENTICATED on purpose: a 200 means the repo is
 * publicly visible (alarm); 404 means private-or-missing (expected). The
 * authenticated call then verifies the token actually reaches the repo.
 *
 * @returns {Promise<{
 *   privacy: "private" | "PUBLIC" | "unknown",
 *   auth: "ok" | "invalid" | "missing" | "unknown",
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
  /** @type {"ok" | "invalid" | "missing" | "unknown"} */
  let auth = "missing";
  if (token) {
    try {
      const authed = await fetch(url, { headers: baseHeaders(token) });
      if (authed.ok) {
        auth = "ok";
        const repo = await authed.json();
        if (repo.private === true) privacy = "private";
        else if (repo.private === false) privacy = "PUBLIC";
      } else {
        auth = "invalid";
      }
    } catch {
      auth = "unknown"; // offline
      reachable = false;
    }
  }

  return { privacy, auth, reachable };
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
  if (!res.ok) throw new Error(`write ${path}: HTTP ${res.status}`);
  const json = await res.json();
  return { sha: json.content.sha };
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
