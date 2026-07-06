// GitHub access layer. The ONLY module that talks to api.github.com.
// Views import from here (or, later, from store.js) — never fetch directly.

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
