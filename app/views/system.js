import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import {
  DATA_REPO,
  tokenAgeDays,
  TOKEN_WARN_AGE_DAYS,
  setDataRepo,
  dataRepoOverridden,
} from "../lib/github.js";
import { formatSyncTime } from "../lib/dates.js";
import { activeProfile, readProfiles, patchProfiles } from "../lib/store.js";
import { TOUR_STEPS, TOUR_TABS } from "../lib/tour.js";
import { notifyTest } from "../lib/worker.js";

/**
 * System status view: app health, sync queue, data-repo checks, token entry.
 * All state lives in the app shell; this view just renders and forwards events.
 * @param {{
 *   sw: "installing" | "ready" | "failed",
 *   sync: Record<string, any>,
 *   repo: Record<string, any> | null,
 *   hasToken: boolean,
 *   draft: string,
 *   onDraft: (v: string) => void,
 *   onSaveToken: () => void,
 *   onTestWrite: () => void,
 *   onExport: () => void,
 *   onReplayTour: () => void,
 *   tourState: import("../lib/tour.js").TourState | null
 * }} props
 */
export function SystemView({
  sw,
  sync,
  repo,
  hasToken,
  draft,
  onDraft,
  onSaveToken,
  onTestWrite,
  onExport,
  onReplayTour,
  tourState,
}) {
  const ageDays = tokenAgeDays();
  const renewSoon = hasToken && ageDays != null && ageDays >= TOKEN_WARN_AGE_DAYS;

  // notification pipeline test (ntfy ping + today's would-fire schedule)
  const [notify, setNotify] = useState(/** @type {null | "busy" | "done"} */ (null));
  const [notifyErr, setNotifyErr] = useState("");
  const [notifyResult, setNotifyResult] = useState(
    /** @type {null | { pinged: boolean, topicSet: boolean, cronReady: boolean, preview: { title: string, body: string }[] }} */ (
      null
    ),
  );
  const runNotifyTest = async () => {
    if (notify === "busy") return;
    setNotify("busy");
    setNotifyErr("");
    setNotifyResult(null); // a failed retest must not leave a stale success tile
    try {
      setNotifyResult(await notifyTest());
    } catch (err) {
      setNotifyErr(err instanceof Error ? err.message : "test failed — needs signal + token");
    }
    setNotify("done");
  };

  // full list for DISPLAY; every write goes through patchProfiles (G2), which
  // mutates the real file by id and refuses when it can't be loaded — a
  // stale/fallback list here can no longer erase other profiles.
  const [allProfiles, setAllProfiles] = useState(
    /** @type {Record<string, any>[] | null} */ (null),
  );
  const [profilesFallback, setProfilesFallback] = useState(false);
  const [profileErr, setProfileErr] = useState("");
  useEffect(() => {
    let alive = true;
    readProfiles().then((p) => {
      if (!alive) return;
      setAllProfiles(p.profiles);
      setProfilesFallback(Boolean(/** @type {any} */ (p).fallback));
    });
    return () => {
      alive = false;
    };
  }, []);
  const me = activeProfile();
  const profile = allProfiles
    ? (allProfiles.find((x) => x.id === me) ?? { id: me, name: me, emoji: "" })
    : null;
  const trainingOn = profile?.trainingEnabled !== false;

  // apply an id-targeted patch through the safe path; mirrors into local
  // state for instant UI, surfaces the refusal case honestly
  const applyPatch = async (
    /** @type {(x: Record<string, any>) => Record<string, any>} */ patch,
  ) => {
    const fallbackEntry = { id: me, name: profile?.name ?? me, emoji: profile?.emoji ?? "" };
    const ok = await patchProfiles((list) =>
      list.some((x) => x.id === me)
        ? list.map((x) => (x.id === me ? patch(x) : x))
        : [...list, patch(fallbackEntry)],
    );
    if (!ok) {
      setProfileErr(
        "couldn't load the real profile list (offline or token not set), nothing was changed, so other profiles stay safe. Try again once synced.",
      );
      return false;
    }
    setProfileErr("");
    setAllProfiles((cur) => (cur ? cur.map((x) => (x.id === me ? patch(x) : x)) : cur));
    return true;
  };

  // per-profile training gate (profiles.json trainingEnabled, absent = true)
  const toggleTraining = () => {
    void applyPatch((x) => ({ ...x, trainingEnabled: !trainingOn }));
  };

  // household (profiles.json household, absent = "home"): which grocery trip
  // this profile's list merges into. Editable so a member can move for a week
  // (Laurie visiting joins "home", then moves back to hers).
  const [householdDraft, setHouseholdDraft] = useState(/** @type {string | null} */ (null));
  const household = /** @type {string} */ (profile?.household ?? "home");
  const householdShown = householdDraft ?? household;
  const saveHousehold = () => {
    const clean = householdShown
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    void applyPatch((x) => {
      const rest = { ...x };
      // "home" (or blank) is the default: store as absent, not as a string
      delete rest.household;
      return clean && clean !== "home" ? { ...rest, household: clean } : rest;
    }).then((ok) => {
      if (ok) setHouseholdDraft(null);
    });
  };

  // family (profiles.json family, optional): the top-level grouping the
  // profile gate organizes people under. Family = who you ARE (fixed-ish);
  // household = who you shop with right now (movable). David's structure,
  // 2026-07-21.
  const [familyDraft, setFamilyDraft] = useState(/** @type {string | null} */ (null));
  const family = /** @type {string} */ (profile?.family ?? "");
  const familyShown = familyDraft ?? family;
  const saveFamily = () => {
    const clean = familyShown
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    void applyPatch((x) => {
      const rest = { ...x };
      delete rest.family;
      return clean ? { ...rest, family: clean } : rest;
    }).then((ok) => {
      if (ok) setFamilyDraft(null);
    });
  };

  // switch profile: never sets a new one itself — just clears the key so
  // main.js's boot check renders the gate on reload, same clean pattern as
  // choosing a profile there.
  const switchProfile = () => {
    localStorage.removeItem("mise.activeProfile");
    location.reload();
  };

  // B4 friend groups: point this install at another private data repo.
  // Switching WIPES local state (cache, profile, token) — data from one
  // group must never bleed into another's install.
  const [repoDraft, setRepoDraft] = useState(
    dataRepoOverridden() ? `${DATA_REPO.owner}/${DATA_REPO.repo}` : "",
  );
  const applyDataRepo = () => {
    if (!setDataRepo(repoDraft)) {
      setProfileErr("data repo must look like owner/repo");
      return;
    }
    localStorage.removeItem("mise.activeProfile");
    localStorage.removeItem("mise.pat");
    try {
      indexedDB.deleteDatabase("mise");
    } catch {
      // reload re-opens fresh either way
    }
    location.reload();
  };

  return html`
    <div class="view">
      <div class="hero"><h1>System</h1></div>

      <a class="tile" href="#/cookbook">
        <div class="k">Recipe Library</div>
        <div class="v">→</div>
        <div class="d">purpose-tagged · macro'd</div>
      </a>

      <div class="tile">
        <h2 class="k">App</h2>
        <div class="row">
          <span class="k">Profile</span>
          <span class="status dim">${profile ? `${profile.emoji} ${profile.name}` : "…"}</span>
        </div>
        <div class="row">
          <span class="k">Training</span>
          <span class="status ${trainingOn ? "ok" : "dim"}">${trainingOn ? "on" : "off"}</span>
        </div>
        <div class="row">
          <span class="k">Shell</span>
          <span class="status ok">running ✓</span>
        </div>
        <div class="row">
          <span class="k">Offline cache</span>
          ${
            sw === "ready"
              ? html`<span class="status ok">ready</span>`
              : sw === "failed"
                ? html`<span class="status bad">unavailable ✗</span>`
                : html`<span class="status dim">installing…</span>`
          }
        </div>
        <div class="actions">
          <button class="secondary" onClick=${switchProfile}>SWITCH PROFILE</button>
          <button class="secondary" onClick=${toggleTraining} disabled=${!profile}>
            ${trainingOn ? "TURN TRAINING OFF" : "TURN TRAINING ON"}
          </button>
        </div>
        <p class="hint">
          training off hides the Train tab, Home's Train row, and workout tracking for this profile
          only.
        </p>
        <div class="row">
          <span class="k">House</span>
          <input
            aria-label="House this profile cooks and shops from"
            value=${householdShown}
            onInput=${(/** @type {any} */ e) => setHouseholdDraft(e.currentTarget.value)}
          />
        </div>
        <div class="actions">
          <button
            class="secondary"
            onClick=${saveHousehold}
            disabled=${!profile || householdDraft === null || householdShown.trim() === household}
          >
            MOVE HOUSE
          </button>
        </div>
        <p class="hint">
          a house is a physical kitchen: everyone in the same house shares the EVERYONE grocery trip
          AND the pantry (one kitchen, one fridge). Moving house also switches you to that house's
          pantry. Move someone for a visit week, move them back after.
        </p>
        <div class="row">
          <span class="k">Family</span>
          <input
            aria-label="Family this person belongs to"
            placeholder="e.g. taranowski"
            value=${familyShown}
            onInput=${(/** @type {any} */ e) => setFamilyDraft(e.currentTarget.value)}
          />
        </div>
        <div class="actions">
          <button
            class="secondary"
            onClick=${saveFamily}
            disabled=${!profile || familyDraft === null || familyShown.trim() === family}
          >
            SET FAMILY
          </button>
        </div>
        <p class="hint">
          family is who you ARE, a house is the kitchen you cook and shop from right now. The
          profile chooser groups people by family; houses can change week to week.
        </p>
        ${
          profilesFallback &&
          html`<p class="hint">
            ⚠ profile list couldn't load (offline or token not set), showing the built-in default.
            Other profiles still exist and are safe; profile edits are blocked until the real list
            loads.
          </p>`
        }
        ${profileErr && html`<p class="hint">⚠ ${profileErr}</p>`}
      </div>

      <div class="tile">
        <h2 class="k">Tour</h2>
        <div class="row tourrow">
          <span class="k">Guided tour</span>
          <button class="secondary" onClick=${onReplayTour}>REPLAY THE TOUR</button>
        </div>
        ${
          tourState &&
          html`<p class="hint num">
            last run:
            ${tourState.status === "done" ? "finished" : `reached step ${tourState.lastStep} of ${TOUR_STEPS.length}`}
          </p>`
        }
        <details class="whatlist">
          <summary class="block-title">What everything does</summary>
          ${Object.entries(TOUR_TABS).map(
            ([route, tab]) => html`
              <div class="batch" key=${route}>
                <div class="k">${tab}</div>
                ${TOUR_STEPS.filter((st) => st.route === route).map(
                  (st) =>
                    html`<div class="whatitem" key=${st.selector}>
                      <b>${st.title}.</b> ${st.text}
                    </div>`,
                )}
              </div>
            `,
          )}
        </details>
      </div>

      <div class="tile">
        <h2 class="k">Sync</h2>
        <div class="row">
          <span class="k">Queued writes</span>
          ${
            sync.loading
              ? html`<span class="status dim">…</span>`
              : sync.flushing
                ? html`<span class="status num dim">syncing…</span>`
                : html`<span class="status num ${sync.pending ? "warn" : "ok"}"
                    >${sync.pending}</span
                  >`
          }
        </div>
        ${
          sync.lastError &&
          sync.pending > 0 &&
          html`<div class="row">
            <span class="k">Last push error</span>
            <span class="status warn">${sync.lastError}</span>
          </div>`
        }
        <div class="row">
          <span class="k">Conflicts</span>
          ${
            sync.loading
              ? html`<span class="status dim">…</span>`
              : html`<span class="status num ${sync.conflicts ? "bad" : "ok"}"
                  >${sync.conflicts}</span
                >`
          }
        </div>
        <div class="row">
          <span class="k">Last sync</span>
          <span class="status num dim"
            >${sync.loading ? "…" : formatSyncTime(sync.lastSyncAt)}</span
          >
        </div>
        ${
          repo?.auth === "invalid" &&
          sync.pending > 0 &&
          html`<p class="hint">Not syncing — your access token needs renewing (see below).</p>`
        }
        <div class="actions">
          <button class="primary" onClick=${onTestWrite}>TEST SYNC WRITE</button>
        </div>
        <p class="hint">
          Writes a timestamp to meta.json in the data repo. Works offline — it queues and pushes
          when signal returns.
        </p>
        <div class="actions">
          <button class="secondary" onClick=${onExport}>⬇ EXPORT MY DATA</button>
        </div>
        <p class="hint">
          Downloads this profile's data (targets, pantry, list, plans, logs, own recipes) as one
          JSON file — your offline backup, works from the local cache even without signal.
        </p>
        <div class="actions">
          <button class="secondary" disabled=${notify === "busy"} onClick=${runNotifyTest}>
            ${notify === "busy" ? "TESTING…" : "🔔 TEST NOTIFICATIONS"}
          </button>
        </div>
        <p class="hint">
          Sends one real ntfy ping to your phone and lists everything today's schedule would send
          (cook reminders, store run, batch day, check-in nags).
        </p>
        ${notifyErr && html`<p class="hint scanerr" role="status">${notifyErr}</p>`}
        ${
          notifyResult &&
          html`<div class="tile" role="status">
            <div class="k">
              ${notifyResult.pinged ? "✓ ping sent — check your phone" : "no ping"} ·
              ${
                notifyResult.cronReady
                  ? "hourly cron LIVE"
                  : notifyResult.topicSet
                    ? "cron waiting on MISE_DATA_TOKEN (Worker secret)"
                    : "cron waiting on NTFY_TOPIC + MISE_DATA_TOKEN (Worker secrets)"
              }
            </div>
            ${
              notifyResult.preview.length === 0
                ? html`<div class="d">
                    nothing scheduled today (no plan, or groceries not confirmed)
                  </div>`
                : notifyResult.preview.map(
                    (n) =>
                      html`<div class="d" key=${n.title + n.body}>
                        <b>${n.title}</b> — ${n.body}
                      </div>`,
                  )
            }
          </div>`
        }
      </div>

      <div class="tile">
        <h2 class="k">Data repo — ${DATA_REPO.owner}/${DATA_REPO.repo}</h2>
        <div class="row">
          <span class="k">Privacy</span>
          ${
            repo == null
              ? html`<span class="status dim">checking…</span>`
              : repo.privacy === "private"
                ? html`<span class="status ok">PRIVATE ✓</span>`
                : repo.privacy === "PUBLIC"
                  ? html`<span class="status bad">PUBLIC ✗</span>`
                  : html`<span class="status warn">unknown (offline?)</span>`
          }
        </div>
        <div class="row">
          <span class="k">Token</span>
          ${
            repo == null
              ? html`<span class="status dim">…</span>`
              : repo.auth === "ok"
                ? html`<span class="status ok">connected ✓</span>`
                : repo.auth === "missing"
                  ? html`<span class="status warn">not set</span>`
                  : repo.auth === "invalid"
                    ? html`<span class="status bad">invalid ✗</span>`
                    : html`<span class="status warn">unverified (offline)</span>`
          }
        </div>
        ${
          renewSoon &&
          html`<p class="hint">
            ⚠ This token is nearly a year old — fine-grained tokens expire at 12 months. Create a
            fresh one now (github.com → Settings → Developer settings → Fine-grained tokens) and
            paste it below before the old one dies mid-week.
          </p>`
        }
        ${
          (!hasToken || repo?.auth === "invalid" || renewSoon) &&
          html`
            ${
              repo?.auth === "invalid" &&
              html`<p class="hint">Your saved token stopped working — paste a new one.</p>`
            }
            <div class="token-form">
              <input
                type="password"
                aria-label="Fine-grained personal access token"
                placeholder="paste fine-grained PAT"
                value=${draft}
                onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
                  onDraft(e.currentTarget.value)}
              />
              <button class="primary" onClick=${onSaveToken}>SAVE</button>
            </div>
            <p class="hint">
              Stored only on this device. Get one at github.com → Settings → Developer settings →
              Fine-grained tokens: access to the ${DATA_REPO.repo} repo only, Contents read/write,
              nothing else.
            </p>
          `
        }
        <div class="row">
          <span class="k">Data repo</span>
          <span class="status ${dataRepoOverridden() ? "warn" : "dim"} num">
            ${DATA_REPO.owner}/${DATA_REPO.repo}
          </span>
        </div>
        <div class="token-form">
          <input
            aria-label="Data repo override (owner/repo)"
            placeholder="owner/repo (friend groups)"
            value=${repoDraft}
            onInput=${(/** @type {any} */ e) => setRepoDraft(e.currentTarget.value)}
          />
          <button class="secondary" onClick=${applyDataRepo}>SWITCH REPO</button>
        </div>
        <p class="hint">
          friend groups (B4): each group lives in its OWN private repo with its own token. Switching
          wipes this device's local data, profile, and token, then reloads — you'll re-enter that
          group's token. Blank + SWITCH returns to the family repo.
        </p>
      </div>
    </div>
  `;
}
