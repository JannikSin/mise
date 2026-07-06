import { html, render } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { checkDataRepo, getToken, setToken, DATA_REPO } from "./lib/github.js";

export const APP = { name: "Mise", version: "0.2.0" };

/** @typedef {Awaited<ReturnType<typeof checkDataRepo>>} RepoStatus */

let checkGen = 0;

function App() {
  const [online, setOnline] = useState(navigator.onLine);
  /** @type {[RepoStatus | null, (s: RepoStatus | null) => void]} */
  const [repo, setRepo] = useState(/** @type {RepoStatus | null} */ (null));
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  const [draft, setDraft] = useState("");
  /** @type {["installing" | "ready" | "failed", (s: "installing" | "ready" | "failed") => void]} */
  const [sw, setSw] = useState(/** @type {"installing" | "ready" | "failed"} */ ("installing"));

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setSw("failed");
      return;
    }
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => setSw("ready"))
      .catch(() => setSw("failed"));
  }, []);

  // generation guard: a slow older check must never overwrite a newer result
  const runCheck = () => {
    const gen = ++checkGen;
    checkDataRepo().then((r) => {
      if (gen === checkGen) setRepo(r);
    });
  };

  useEffect(runCheck, [hasToken, online]);

  const saveToken = () => {
    if (!draft.trim()) return;
    setToken(draft);
    setDraft("");
    setHasToken(true);
    // re-verify directly: when replacing an invalid token, hasToken is
    // already true, so the effect above would not re-fire
    runCheck();
  };

  const publicAlarm = repo?.privacy === "PUBLIC";
  // header and probe results must never disagree: offline if either says so
  const effectiveOnline = online && (repo ? repo.reachable : true);

  return html`
    ${
      publicAlarm &&
      html`<div class="banner red">
        ⚠ DATA REPO IS PUBLIC — ${DATA_REPO.owner}/${DATA_REPO.repo} is visible to anyone. Make it
        private on GitHub now: Settings → Danger Zone → Change visibility.
      </div>`
    }

    <header class="app">
      <h1>MISE //</h1>
      <span class="ver num">v${APP.version}</span>
      <span class="net ${effectiveOnline ? "" : "off"}"
        >${effectiveOnline ? "● ONLINE" : "○ OFFLINE"}</span
      >
    </header>

    <div class="tiles">
      <div class="tile">
        <h2>System</h2>
        <div class="row">
          <span class="k">App shell</span>
          <span class="status ok">hello, David ✓</span>
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
      </div>

      <div class="tile">
        <h2>Data repo — ${DATA_REPO.owner}/${DATA_REPO.repo}</h2>
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
          (!hasToken || repo?.auth === "invalid") &&
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
                  setDraft(e.currentTarget.value)}
              />
              <button class="primary" onClick=${saveToken}>SAVE</button>
            </div>
            <p class="hint">
              Stored only in this device's localStorage. Scope: ${DATA_REPO.repo} repo, Contents
              read/write, nothing else.
            </p>
          `
        }
      </div>
    </div>
  `;
}

const root = document.getElementById("app");
if (root) render(html`<${App} />`, root);
