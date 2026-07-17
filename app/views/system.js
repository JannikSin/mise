import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { DATA_REPO, tokenAgeDays, TOKEN_WARN_AGE_DAYS } from "../lib/github.js";
import { formatSyncTime } from "../lib/dates.js";
import { activeProfile, readProfiles, write } from "../lib/store.js";

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
 *   onTestWrite: () => void
 * }} props
 */
export function SystemView({ sw, sync, repo, hasToken, draft, onDraft, onSaveToken, onTestWrite }) {
  const ageDays = tokenAgeDays();
  const renewSoon = hasToken && ageDays != null && ageDays >= TOKEN_WARN_AGE_DAYS;

  // full list, not just the active profile: the training toggle below writes
  // the whole profiles.json back, so the other profiles must be preserved
  const [allProfiles, setAllProfiles] = useState(
    /** @type {Record<string, any>[] | null} */ (null),
  );
  useEffect(() => {
    let alive = true;
    readProfiles().then((p) => {
      if (alive) setAllProfiles(p.profiles);
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

  // per-profile training gate (profiles.json trainingEnabled, absent = true).
  // If the active profile isn't in the file yet (fresh-install fallback), it
  // gets appended so the choice actually persists.
  const toggleTraining = () => {
    if (!allProfiles || !profile) return;
    const next = allProfiles.some((x) => x.id === me)
      ? allProfiles.map((x) => (x.id === me ? { ...x, trainingEnabled: !trainingOn } : x))
      : [...allProfiles, { ...profile, trainingEnabled: !trainingOn }];
    setAllProfiles(next);
    void write("profiles.json", { profiles: next });
  };

  // switch profile: never sets a new one itself — just clears the key so
  // main.js's boot check renders the gate on reload, same clean pattern as
  // choosing a profile there.
  const switchProfile = () => {
    localStorage.removeItem("mise.activeProfile");
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
      </div>
    </div>
  `;
}
