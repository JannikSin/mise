// WHICH BACKEND THIS BUILD TALKS TO (Mise 2.0, plan section 5).
//
// Like the data branch (github.js dataBranch), this is decided by the shell
// and the ORIGIN, never by a localStorage setting: a typed value is how a
// live phone would end up pointed at the wrong store.
//   - No `<meta name="mise-backend" content="supabase">` in index.html (every
//     1.9x shell, node tests, scripts): GitHub, exactly as 1.95.
//   - With that meta: Supabase, on the project the origin owns. The live
//     origin gets the live project, the sandbox origin the sandbox project,
//     any other origin none (the adapter then refuses every call).
// The values below are placeholders. The owner commits the real project URL
// and publishable key (plan section 8, step 8); a publishable key is public
// by design, the database policies are what protect the data.

export const SUPABASE_LIVE = {
  url: "https://YOUR-PROJECT.supabase.co",
  publishableKey: "sb_publishable_PLACEHOLDER",
  stamp: "supabase",
};
export const SUPABASE_SANDBOX = {
  url: "https://YOUR-SANDBOX-PROJECT.supabase.co",
  publishableKey: "sb_publishable_PLACEHOLDER",
  stamp: "supabase-sandbox",
};

const LIVE_ORIGIN = "https://janniksin.github.io";
const SANDBOX_ORIGIN = "https://mise-next.pages.dev";

/**
 * The slug of the profile whose files sit at the data root. Kept in step with
 * store.js pathFor and the database's private.settings root_profile.
 */
export const ROOT_PROFILE = "david";

/**
 * A 1.95 record carries the data branch it was queued under. On a Supabase
 * build it replays into the project that took over that branch's data: the
 * live queue into the live project, the sandbox queue into the sandbox.
 * @type {Record<string, string>}
 */
export const LEGACY_STAMP_OF = {
  [SUPABASE_LIVE.stamp]: "main",
  [SUPABASE_SANDBOX.stamp]: "sandbox",
};

/** @returns {"github" | "supabase"} */
export function backendChoice() {
  const doc = /** @type {any} */ (globalThis).document;
  const meta =
    doc && typeof doc.querySelector === "function"
      ? (doc.querySelector('meta[name="mise-backend"]')?.getAttribute("content") ?? "").trim()
      : "";
  return meta === "supabase" ? "supabase" : "github";
}

/**
 * The Supabase project this origin owns, or null (writes and reads refused).
 * Outside a browser there is no origin and the live project is assumed, the
 * same rule dataBranch uses; tests inject a fake client anyway.
 * @returns {{ url: string, publishableKey: string, stamp: string } | null}
 */
export function supabaseProject() {
  const loc = /** @type {any} */ (globalThis).location;
  const origin = loc && typeof loc.origin === "string" ? loc.origin : "";
  if (!origin || origin === "null" || origin === LIVE_ORIGIN) return SUPABASE_LIVE;
  if (origin === SANDBOX_ORIGIN) return SUPABASE_SANDBOX;
  return null;
}

/**
 * Has the owner committed a real project yet? A placeholder project is never
 * called: the adapter refuses instead of sending a request nowhere.
 * @param {{ url: string, publishableKey: string } | null} project
 */
export function projectConfigured(project) {
  return Boolean(
    project && !project.url.includes("YOUR-") && !project.publishableKey.includes("PLACEHOLDER"),
  );
}
