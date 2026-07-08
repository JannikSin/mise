import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { SYMPTOMS, protocolFor } from "../lib/remedies.js";
import { liveRemedy } from "../lib/worker.js";
import { recipesById } from "../lib/plan.js";

/**
 * Sick/down mode (blueprint §6.7): pick symptoms → merged protocol.
 * Rules-based and fully offline (the rules ship with the app); the live
 * ask box is the one online extra.
 * @param {{ recipes: Record<string, any>[], hasToken: boolean, repo: Record<string, any> | null }} props
 */
export function RemediesView({ recipes, hasToken, repo }) {
  const [picked, setPicked] = useState(/** @type {string[]} */ ([]));
  const protocol = protocolFor(picked);
  const byId = recipesById(recipes);
  // live remedy: free text -> Worker -> same protocol shape as the rules
  const [liveText, setLiveText] = useState("");
  const [live, setLive] = useState(
    /** @type {null | "busy" | { error: string } | { protocol: Record<string, string[]> }} */ (
      null
    ),
  );

  const askLive = async () => {
    const text = liveText.trim();
    if (!text) return;
    setLive("busy");
    try {
      setLive({ protocol: await liveRemedy(text) });
    } catch (err) {
      setLive({
        error:
          err instanceof Error
            ? err.message
            : "no answer — needs signal; the picker above always works",
      });
    }
  };

  const liveErr = typeof live === "object" && live !== null && "error" in live ? live.error : null;
  const liveProto =
    typeof live === "object" && live !== null && "protocol" in live ? live.protocol : null;
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  const toggle = (/** @type {string} */ id) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

  // h3 so the live answer's headings don't duplicate the rules protocol's
  // h2s in screen-reader navigation
  /** @param {string} title @param {string[]} items */
  const liveSection = (title, items) =>
    items.length > 0 &&
    html`
      <h3 class="block-title">${title}</h3>
      <ul class="protolist">
        ${items.map((i) => html`<li key=${i}>${i}</li>`)}
      </ul>
    `;

  /** @param {string} title @param {string[]} items */
  const section = (title, items) =>
    items.length > 0 &&
    html`
      <h2 class="block-title">${title}</h2>
      <ul class="protolist">
        ${items.map((i) => html`<li key=${i}>${i}</li>`)}
      </ul>
    `;

  return html`
    <div class="view">
      <a class="backlink" href="#/">← BACK</a>
      <div class="hero"><h1>Feeling off?</h1></div>

      <h2 class="block-title">What's going on</h2>
      <div class="chips wrapchips" role="group" aria-label="Symptoms">
        ${SYMPTOMS.map(
          (s) => html`
            <button
              class="chip ${picked.includes(s.id) ? "on" : ""}"
              aria-pressed=${picked.includes(s.id)}
              onClick=${() => toggle(s.id)}
            >
              ${s.label}
            </button>
          `,
        )}
      </div>

      ${!protocol && html`<p class="hint">pick what applies — combinations merge.</p>`}
      ${
        protocol &&
        html`
          ${section("Drink", protocol.teas)} ${section("Eat", protocol.foods)}
          ${section("Avoid", protocol.avoid)} ${section("Do", protocol.notes)}
          ${
            protocol.recipeIds.length > 0 &&
            html`
              <h2 class="block-title">From the cookbook</h2>
              <div class="slots">
                ${protocol.recipeIds.map((id) => {
                  const r = byId.get(id);
                  return html`
                    <div class="slot" key=${id}>
                      <a class="slotlink" href="#/recipe/${encodeURIComponent(id)}">
                        <span class="name">${r ? r.name : id}</span>
                        ${
                          r &&
                          html`<span class="m num"
                            ><b>${r.nutrition?.calories}</b> kcal · ${r.totalTime}m</span
                          >`
                        }
                      </a>
                    </div>
                  `;
                })}
              </div>
            `
          }
          <p class="hint">
            Home care, not medical advice — fever past 3 days, trouble breathing, or anything scary:
            see a real doctor. Complex cases: ask Claude in Cowork.
          </p>
        `
      }

      <h2 class="block-title">Something else? Ask live</h2>
      <div class="token-form">
        <input
          aria-label="Describe how you feel"
          placeholder="describe it (e.g. dizzy after morning runs)"
          value=${liveText}
          onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
            setLiveText(e.currentTarget.value)}
        />
        <button
          class="primary"
          onClick=${askLive}
          disabled=${live === "busy" || !liveText.trim() || tokenBlocked}
        >
          ${live === "busy" ? "ASKING…" : "ASK"}
        </button>
      </div>
      <p class="hint">
        ${
          tokenBlocked
            ? repo?.auth === "invalid"
              ? "token needs renewing — SYS"
              : "connect token in SYS to ask live"
            : "fresh answer from Claude — needs signal; the picker above works offline."
        }
      </p>
      ${liveErr && html`<p class="hint scanerr" role="status">${liveErr}</p>`}
      ${
        liveProto &&
        html`
          <div role="status">
            ${liveSection("Drink", liveProto.teas ?? [])}
            ${liveSection("Eat", liveProto.foods ?? [])}
            ${liveSection("Avoid", liveProto.avoid ?? [])}
            ${liveSection("Do", liveProto.notes ?? [])}
          </div>
        `
      }
    </div>
  `;
}
