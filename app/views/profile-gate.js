import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { readProfiles, write } from "../lib/store.js";

/**
 * Full-screen profile chooser: shown by main.js when localStorage's
 * mise.activeProfile is unset (fresh install, or after System's "switch
 * profile" clears it). Tapping a profile sets the key and reloads — same
 * clean pattern as token entry — so every scoped read/write re-derives from
 * the new value on next boot.
 * @returns {import("preact").VNode}
 */
export function ProfileGateView() {
  const [profiles, setProfiles] = useState(/** @type {Record<string, any>[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [phase, setPhase] = useState("gain");

  useEffect(() => {
    let alive = true;
    readProfiles().then((p) => {
      if (!alive) return;
      setProfiles(p.profiles);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const choose = (/** @type {string} */ id) => {
    localStorage.setItem("mise.activeProfile", id);
    location.reload();
  };

  const addProfile = async () => {
    const trimmedName = name.trim();
    const trimmedEmoji = emoji.trim();
    if (!trimmedName || !trimmedEmoji) return;
    const id = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id || profiles.some((p) => p.id === id)) return;
    const next = { profiles: [...profiles, { id, name: trimmedName, emoji: trimmedEmoji, phase }] };
    // await the cache write (not the network flush, which queues and
    // survives fine) so the reload below never races the local record.
    await write("profiles.json", next);
    choose(id);
  };

  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">who's checking in?</div>
      </div>
      ${loading && html`<p class="hint">loading profiles…</p>`}
      <div class="slots">
        ${profiles.map(
          (p) => html`
            <button class="ask" key=${p.id} onClick=${() => choose(p.id)}>
              ${p.emoji} ${p.name}
            </button>
          `,
        )}
      </div>
      <details>
        <summary class="block-title">+ add profile</summary>
        <div class="tile">
          <div class="token-form">
            <input
              aria-label="Profile name"
              placeholder="name"
              value=${name}
              onInput=${(/** @type {any} */ e) => setName(e.currentTarget.value)}
            />
            <input
              aria-label="Profile emoji"
              placeholder="emoji"
              value=${emoji}
              onInput=${(/** @type {any} */ e) => setEmoji(e.currentTarget.value)}
            />
          </div>
          <div class="chips wrapchips">
            <button class="chip ${phase === "gain" ? "on" : ""}" onClick=${() => setPhase("gain")}>
              gain
            </button>
            <button class="chip ${phase === "loss" ? "on" : ""}" onClick=${() => setPhase("loss")}>
              loss
            </button>
          </div>
          <div class="actions">
            <button class="primary" onClick=${addProfile}>ADD &amp; OPEN</button>
          </div>
        </div>
      </details>
    </div>
  `;
}
