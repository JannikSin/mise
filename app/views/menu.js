import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { scanMenu } from "../lib/worker.js";

/**
 * Menu scan: photograph a restaurant menu, get a per-diner order report
 * (what fits each person's goal and targets, what to skip). Nothing is
 * persisted; it's a decision aid for the moment of ordering.
 * @param {{
 *   profiles: Record<string, any>[],
 *   me: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   onDinerFacts: (ids: string[]) => Promise<Record<string, any>[]>
 * }} props
 */
export function MenuView({ profiles, me, hasToken, repo, onDinerFacts }) {
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const myHouse = (profiles ?? []).find((p) => p.id === me)?.household ?? "home";
  const housemates = (profiles ?? []).filter((p) => (p.household ?? "home") === myHouse);
  const [picked, setPicked] = useState(/** @type {string[]} */ ([me]));
  const [scan, setScan] = useState(
    /** @type {null | "busy" | { error: string } | { report: { diners: Record<string, any>[], notes: string[] } }} */ (
      null
    ),
  );
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  const toggle = (/** @type {string} */ id) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

  const onPhotoPicked = async (/** @type {{ currentTarget: HTMLInputElement }} */ e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ""; // same photo re-pickable
    if (!file || scan === "busy" || picked.length === 0) return;
    setScan("busy");
    try {
      const diners = await onDinerFacts(picked);
      const report = await scanMenu(file, /** @type {any} */ (diners));
      setScan(
        report.diners.length === 0
          ? { error: "could not read the menu — try a flatter, brighter shot" }
          : { report },
      );
    } catch (err) {
      setScan({ error: err instanceof Error ? err.message : "scan failed — try again" });
    }
  };

  const report = typeof scan === "object" && scan !== null && "report" in scan ? scan.report : null;
  const scanErr = typeof scan === "object" && scan !== null && "error" in scan ? scan.error : null;

  return html`
    <div class="view">
      <a class="backlink" href="#/today">← COOK</a>
      <div class="hero"><h1>Menu scan</h1></div>
      <p class="hint">
        eating out? photograph the menu and get an order that still lands on everyone's targets.
      </p>

      <h2 class="block-title">Who's at the table</h2>
      <div class="chips wrapchips" role="group" aria-label="Diners">
        ${housemates.map(
          (p) => html`
            <button
              class="chip ${picked.includes(p.id) ? "on" : ""}"
              aria-pressed=${picked.includes(p.id)}
              key=${p.id}
              onClick=${() => toggle(p.id)}
            >
              ${p.emoji ?? ""} ${p.name ?? p.id}
            </button>
          `,
        )}
      </div>

      <div class="actions">
        <button
          class="ask scanbtn"
          disabled=${scan === "busy" || picked.length === 0 || tokenBlocked}
          onClick=${() => fileRef.current?.click()}
        >
          ${scan === "busy" ? "READING THE MENU…" : "📷 SCAN THE MENU"}
          <small>photograph the menu page</small>
        </button>
        <input
          ref=${fileRef}
          class="visuallyhidden"
          type="file"
          accept="image/*"
          capture="environment"
          tabindex="-1"
          aria-hidden="true"
          disabled=${scan === "busy"}
          onChange=${onPhotoPicked}
        />
      </div>
      ${
        tokenBlocked &&
        html`<p class="hint">
          ${repo?.auth === "invalid" ? "token needs renewing — SYS" : "connect token in SYS first"}
        </p>`
      }
      ${scanErr && html`<p class="hint scanerr" role="status">${scanErr}</p>`}
      ${
        report &&
        html`<div role="status">
          ${report.diners.map(
            (d) => html`
              <div class="tile" key=${d.name}>
                <div class="k">${d.name} — order</div>
                ${(d.picks ?? []).map(
                  (/** @type {any} */ p) => html`
                    <div class="d" key=${p.item}>
                      <b>${p.item}</b>
                      <span class="num"> · ~${p.estCalories} kcal · ${p.estProtein}P</span>
                      <div class="hint">${p.why}</div>
                    </div>
                  `,
                )}
                ${
                  (d.skip ?? []).length > 0 &&
                  html`<div class="d hint">skip: ${d.skip.join(" · ")}</div>`
                }
                ${
                  (d.picks ?? []).length === 0 &&
                  (d.skip ?? []).length === 0 &&
                  html`<div class="d hint">nothing on this menu fits their targets cleanly</div>`
                }
              </div>
            `,
          )}
          ${
            report.notes.length > 0 &&
            html`<div class="tile">
              <div class="k">table notes</div>
              ${report.notes.map((n) => html`<div class="d" key=${n}>${n}</div>`)}
            </div>`
          }
          <p class="hint">estimates, not gospel — restaurant portions vary.</p>
        </div>`
      }
    </div>
  `;
}
