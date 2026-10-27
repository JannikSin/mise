// THE SUPABASE SHELL'S BOOT (Mise 2.0, worker fix loop 1, item 15; P3
// knows-you). main.js imports this file ONLY on a shell that carries
// `<meta name="mise-backend" content="supabase">`, with a dynamic import, so
// a GitHub shell (every 1.9x shell, index.html as committed) never loads it
// or the vendored supabase-js: it boots exactly as 1.95.
//
// What it does, in order:
//   1. Makes the one supabase-js client for this origin's project
//      (backend/config.js supabaseProject; a placeholder project makes no
//      client, and the gate then says sign-in is not set up yet).
//   2. Hands the gate its auth client (setAuthClientFactory).
//   3. Builds the session boot over the REAL store and backend seam
//      (session-boot.js), which from that moment keeps SWITCH PROFILE hidden
//      until whoami has answered (seam C3).
// `boot()` then runs the session boot and, on a good sign-in, makes the
// signed-in person the active profile (a member always; the admin only when
// no profile was chosen on this phone yet), so the 1.95 render picks the app.

import { createClient } from "../../vendor/supabase-js/supabase.esm.js";
import {
  supabaseProject,
  projectConfigured,
  SUPABASE_SANDBOX,
  ROOT_PROFILE,
} from "./backend/config.js";
import { setAuthClientFactory } from "../views/auth-gate.js";
import { createSessionBoot } from "./session-boot.js";
import { installBackend, lockedBackend } from "./backend.js";
import { createSupabaseAdapter } from "./backend/supabase-adapter.js";
import { createCompositeBackend } from "./backend/composite.js";
import { createGithubAdapter } from "./backend/github-adapter.js";
import {
  onSessionChange,
  resetFileChecks,
  flushNow,
  purgeEverything,
  refusedRecords,
  discardRefused,
  canSwitchProfile,
  acquireStoreLock,
} from "./store.js";

/** the profile pick the 1.95 render reads */
const ACTIVE = "mise.activeProfile";

/**
 * @param {{
 *   createClientImpl?: (url: string, key: string, options?: Record<string, unknown>) => any,
 *   storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void } | null,
 *   project?: { url: string, publishableKey: string, stamp: string } | null,
 * }} [o] `project` defaults to this origin's (tests pass one)
 * @returns {null | { client: any, boot: () => Promise<"signed-in" | "signed-out" | "revoked" | "offline" | "expired"> }}
 */
export function startSupabase(o = {}) {
  const project = o.project === undefined ? supabaseProject() : o.project;
  if (!project || !projectConfigured(project)) {
    setAuthClientFactory(null);
    return null;
  }
  const client = (o.createClientImpl ?? createClient)(project.url, project.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // the invite and reset links carry a token HASH that only the SET
      // PASSWORD tap may spend (E6); supabase-js must not read the URL itself
      detectSessionInUrl: false,
    },
  });
  setAuthClientFactory(() => client.auth);
  const storage = o.storage === undefined ? safeStorage() : o.storage;
  const session = createSessionBoot({
    client,
    project: {
      stamp: project.stamp,
      label: project.stamp === SUPABASE_SANDBOX.stamp ? "sandbox" : "live",
    },
    rootProfile: ROOT_PROFILE,
    storage,
    seam: {
      installBackend,
      lockedBackend,
      createSupabaseAdapter,
      createCompositeBackend,
      createGithubAdapter,
      onSessionChange,
      resetFileChecks,
      flushNow,
      purgeEverything,
      refusedRecords,
      discardRefused,
      canSwitchProfile,
      acquireStoreLock,
    },
  });
  return {
    client,
    boot: async () => {
      const r = await session.boot();
      const who = session.whoNow();
      if (r === "signed-in" && who) {
        try {
          if (!who.admin || !storage?.getItem(ACTIVE)) storage?.setItem(ACTIVE, who.slug);
        } catch {
          // storage refused: store.activeProfile() pins a member to themselves anyway
        }
      }
      return r;
    },
  };
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
