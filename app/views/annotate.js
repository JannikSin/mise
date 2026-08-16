import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { annotateRecipe, saveAnnotation } from "../lib/worker.js";
import { screenTextForDiners, unconfirmedReason, expandAvoid } from "../lib/annotate.js";
import { recipeConflicts } from "../lib/plan.js";

// mirror of worker/src/lib.js OBJECTIVES (separate deploy targets share no module)
const OBJECTIVES = ["fit-the-plan", "taste", "same-time", "faster", "simpler"];

/**
 * Recipe Scan (HBP P2): a recipe enters by URL or photo, the engine annotates
 * it under the household's plan, macros, pantry and per-diner avoid lists,
 * and one tap saves it to the cookbook unpromoted. Entered from the cookbook,
 * menu-scan pattern: not a tab.
 *
 * Safety posture, enforced here on top of the Worker's validators:
 *  - a diner whose targets read failed is UNCONFIRMED: the scan refuses to
 *    run (fail closed, never "no allergies")
 *  - the returned transcription and result are re-screened CLIENT-side on
 *    each diner's untruncated, derivative-expanded avoid list (the Worker's
 *    20-term cap must not be the last line)
 *  - photo scans and tier-2 / refusal / abandon results render but never save
 * @param {{
 *   profiles: Record<string, any>[],
 *   me: string,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   recipes: Record<string, any>[],
 *   plan: Record<string, any> | null,
 *   pantry: Record<string, any>,
 *   targets: Record<string, any> | null,
 *   onDinerFacts: (ids: string[]) => Promise<Record<string, any>[]>,
 *   onSaved: (recipe: Record<string, any>) => void
 * }} props
 */
export function AnnotateView({
  profiles,
  me,
  hasToken,
  repo,
  recipes,
  plan,
  pantry,
  targets,
  onDinerFacts,
  onSaved,
}) {
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const myHouse = (profiles ?? []).find((p) => p.id === me)?.household ?? "home";
  const housemates = (profiles ?? []).filter((p) => (p.household ?? "home") === myHouse);
  const [url, setUrl] = useState("");
  const [objective, setObjective] = useState("fit-the-plan");
  const [picked, setPicked] = useState(/** @type {string[]} */ ([me]));
  const [scan, setScan] = useState(
    /** @type {null | "busy" | { error: string } | { hardStop: string[] } | Record<string, any>} */ (
      null
    ),
  );
  const [save, setSave] = useState(
    /** @type {null | "busy" | "done" | { error: string }} */ (null),
  );
  const [diners, setDiners] = useState(/** @type {Record<string, any>[]} */ ([]));
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  const toggle = (/** @type {string} */ id) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

  const pantryStaples = (pantry?.staples ?? [])
    .filter((/** @type {any} */ s) => s.onHand)
    .map((/** @type {any} */ s) => String(s.name));

  const context = () => ({
    plan: [
      ...new Set(
        (plan?.entries ?? [])
          .map((/** @type {any} */ e) =>
            e.recipeId
              ? String(recipes.find((r) => r.id === e.recipeId)?.name ?? "")
              : String(e.freeText ?? ""),
          )
          .filter(Boolean),
      ),
    ].slice(0, 25),
    pantry: pantryStaples.slice(0, 60),
    macros: targets?.macros
      ? `${targets.macros.calories ?? 0} kcal / ${targets.macros.protein ?? 0} g protein (${targets.phase ?? "maintain"})`
      : "",
  });

  const run = async (/** @type {File | null} */ file) => {
    if (scan === "busy") return;
    if (picked.length === 0) {
      setScan({ error: "pick who's eating first" });
      return;
    }
    if (!file && !url.trim()) {
      setScan({ error: "paste a recipe URL or take a photo" });
      return;
    }
    setScan("busy");
    setSave(null);
    try {
      const facts = await onDinerFacts(picked);
      setDiners(facts);
      // fail-closed gate (C1): an unread profile never screens as allergy-free
      const unread = unconfirmedReason(/** @type {any} */ (facts));
      if (unread) {
        setScan({ error: unread });
        return;
      }
      const resp = await annotateRecipe({
        url: file ? undefined : url.trim(),
        file: file ?? undefined,
        objective,
        diners: facts,
        context: context(),
      });
      if (resp.hardStop) {
        setScan({ hardStop: resp.hardStop.reasons ?? [] });
        return;
      }
      if (!resp.result) {
        setScan({ error: "nothing usable came back, try again" });
        return;
      }
      // the untruncated client screen (C2): last line, past the Worker's cap
      const hits = screenTextForDiners(
        `${resp.transcription ?? ""} ${JSON.stringify(resp.result)}`,
        /** @type {any} */ (facts),
      );
      if (hits.length > 0) {
        setScan({ hardStop: hits });
        return;
      }
      setScan(resp);
    } catch (err) {
      setScan({ error: err instanceof Error ? err.message : "scan failed, try again" });
    }
  };

  const onPhotoPicked = async (/** @type {{ currentTarget: HTMLInputElement }} */ e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (file) await run(file);
  };

  const doSave = async () => {
    if (save === "busy" || typeof scan !== "object" || scan === null || !("result" in scan)) return;
    setSave("busy");
    try {
      const { recipe } = await saveAnnotation({
        result: scan.result,
        transcription: scan.transcription ?? "",
        extracted: scan.extracted ?? "",
        path: scan.path,
        sourceUrl: url.trim(),
        pantryStaples,
      });
      onSaved(recipe);
      setSave("done");
    } catch (err) {
      setSave({ error: err instanceof Error ? err.message : "save failed, try again" });
    }
  };

  // cookbook alternatives for a hard stop: real recipes every picked diner
  // clears, never an invented dish (§0.5 by construction)
  const alternatives = () =>
    recipes
      .filter((r) =>
        diners.every((d) => recipeConflicts(r, d.diet, expandAvoid(d.avoid)).length === 0),
      )
      .slice(0, 3)
      .map((r) => r.name);

  const result =
    typeof scan === "object" && scan !== null && "result" in scan
      ? /** @type {Record<string, any>} */ (scan.result)
      : null;
  const transcription =
    typeof scan === "object" && scan !== null && "transcription" in scan
      ? String(scan.transcription)
      : "";
  const scanErr = typeof scan === "object" && scan !== null && "error" in scan ? scan.error : null;
  const hardStop =
    typeof scan === "object" && scan !== null && "hardStop" in scan
      ? /** @type {string[]} */ (scan.hardStop)
      : null;
  const eligible =
    typeof scan === "object" && scan !== null && "saveEligible" in scan
      ? /** @type {{ ok: boolean, reason: string }} */ (scan.saveEligible)
      : null;

  const tempLine = (/** @type {any} */ t) =>
    `${t.value} °${t.unit} · ${t.label}${t.fromSource ? "" : " · set by the app"}`;

  return html`
    <div class="view">
      <a class="backlink" href="#/cookbook">← COOKBOOK</a>
      <div class="hero"><h1>Recipe scan</h1></div>
      <p class="hint">
        found a recipe? paste its link or photograph the page. the engine converts it to grams, pins
        real temperatures, and bends it toward the plan without changing the dish.
      </p>

      <h2 class="block-title">Objective</h2>
      <div class="chips wrapchips" role="group" aria-label="Objective">
        ${OBJECTIVES.map(
          (o) => html`
            <button
              class="chip ${objective === o ? "on" : ""}"
              aria-pressed=${objective === o}
              key=${o}
              onClick=${() => setObjective(o)}
            >
              ${o}
            </button>
          `,
        )}
      </div>

      <h2 class="block-title">Who's eating it</h2>
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

      <div class="token-form">
        <input
          type="url"
          inputmode="url"
          aria-label="Recipe URL"
          placeholder="https://… the recipe page"
          value=${url}
          disabled=${scan === "busy" || tokenBlocked}
          onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
            setUrl(e.currentTarget.value)}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
            if (e.key === "Enter") void run(null);
          }}
        />
        <button
          class="primary"
          disabled=${scan === "busy" || tokenBlocked || picked.length === 0}
          onClick=${() => void run(null)}
        >
          SCAN
        </button>
      </div>
      <div class="actions">
        <button
          class="ask scanbtn"
          disabled=${scan === "busy" || picked.length === 0 || tokenBlocked}
          onClick=${() => fileRef.current?.click()}
        >
          ${scan === "busy" ? "READING THE RECIPE…" : "📷 PHOTOGRAPH THE PAGE"}
          <small>photo scans render only; saving needs the URL</small>
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
          ${repo?.auth === "invalid" ? "token needs renewing: Settings" : "connect token in Settings first"}
        </p>`
      }
      ${scan === "busy" && html`<p class="hint" role="status">two passes: transcribing, then annotating…</p>`}
      ${scanErr && html`<p class="hint scanerr" role="status">${scanErr}</p>`}
      ${
        hardStop &&
        html`<div class="tile" role="status">
          <div class="k">stopped: this recipe hits a never-serve list</div>
          ${hardStop.map((r) => html`<div class="d" key=${r}>${r}</div>`)}
          ${
            alternatives().length > 0 &&
            html`<div class="d hint">from the cookbook instead: ${alternatives().join(" · ")}</div>`
          }
        </div>`
      }
      ${
        result &&
        html`<div role="status">
          <div class="tile">
            <div class="k">${result.title}</div>
            ${
              result.mode === "refusal"
                ? html`
                    <div class="d"><b>NOT MOVED.</b> ${result.refusalReason}</div>
                    <div class="d hint">
                      this recipe carries numbers that are pathogen controls. it is typeset with
                      unit conversions alongside, corrected nowhere, and never scored.
                    </div>
                  `
                : result.mode === "abandon"
                  ? html`
                      <div class="d">
                        <b>rebuild this by hand.</b>
                        <span class="num"> scored ${result.score} under ${result.objective}</span>
                      </div>
                      <div class="d hint">
                        under 40 the page would be more red ink than recipe. nothing is saved.
                      </div>
                    `
                  : html`
                      <div class="d">
                        <span class="num">${result.score}</span> under ${result.objective} ·
                        <b> ${result.mode}</b>
                        ${result.mode === "annotated" ? " · original order and step count kept" : ""}
                      </div>
                    `
            }
            ${
              result.riskGroups &&
              html`<div class="d scanerr">
                carries a tier-2 temperature or raw preparation: not for pregnant,
                immunocompromised, under-5 or over-65 eaters.
              </div>`
            }
            ${
              (result.allergensFound ?? []).length > 0 &&
              html`<div class="d">contains: ${result.allergensFound.join(", ")}</div>`
            }
            ${diners.map(
              (d) => html`
                <div class="d hint" key=${d.id}>
                  ${
                    (d.avoid ?? []).length > 0
                      ? `${d.name}: screened against ${expandAvoid(d.avoid).length} terms`
                      : `${d.name}: no restrictions on file, not checked`
                  }
                </div>
              `,
            )}
          </div>

          ${
            result.mode === "rebuild" &&
            result.deal &&
            html`<div class="tile">
              <div class="k">the deal</div>
              ${result.deal.time && html`<div class="d">${result.deal.time}</div>`}
              ${result.deal.cost && html`<div class="d">${result.deal.cost}</div>`}
              ${result.deal.buys && html`<div class="d">buys you: ${result.deal.buys}</div>`}
              ${result.deal.skipIf && html`<div class="d hint">skip if ${result.deal.skipIf}</div>`}
            </div>`
          }
          ${
            (result.planFit ?? []).length > 0 &&
            html`<div class="tile">
              <div class="k">fit the plan</div>
              ${result.planFit.map(
                (/** @type {string} */ l) => html`<div class="d" key=${l}>${l}</div>`,
              )}
            </div>`
          }
          ${
            (result.summary ?? []).length > 0 &&
            result.mode !== "abandon" &&
            html`<div class="tile">
              <div class="k">what changed</div>
              ${result.summary.map(
                (/** @type {string} */ s) => html`<div class="d" key=${s}>${s}</div>`,
              )}
            </div>`
          }
          ${
            result.mode !== "abandon" &&
            html`<div class="tile">
              <div class="k">ingredients · grams</div>
              ${result.ingredients.map(
                (/** @type {any} */ i) => html`
                  <div class="d" key=${i.food}>
                    <span class="num">${i.grams} g</span> ${i.food}
                    ${i.optional ? html`<span class="hint"> (optional)</span>` : ""}
                    ${i.wasOriginal ? html`<span class="hint"> was: ${i.wasOriginal}</span>` : ""}
                    ${i.note && html`<div class="hint">${i.note}</div>`}
                  </div>
                `,
              )}
            </div>`
          }
          ${
            result.mode !== "abandon" &&
            result.steps.map(
              (/** @type {any} */ s) => html`
                <div class="tile" key=${s.n}>
                  <div class="k">${s.n}. ${s.title || "step"}</div>
                  <div class="d">${s.text}</div>
                  ${(s.temps ?? []).map(
                    (/** @type {any} */ t) =>
                      html`<div class="d num" key=${tempLine(t)}>${tempLine(t)}</div>`,
                  )}
                  ${(s.notes ?? []).map(
                    (/** @type {any} */ n) => html`<div class="d hint" key=${n}>${n}</div>`,
                  )}
                </div>
              `,
            )
          }

          <details class="tile">
            <summary class="block-title">what the engine read (the transcription)</summary>
            <div class="d hint">${transcription}</div>
          </details>

          ${
            eligible?.ok && save !== "done"
              ? html`<div class="actions">
                  <button
                    class="primary"
                    disabled=${save === "busy"}
                    onClick=${() => void doSave()}
                  >
                    ${save === "busy" ? "SAVING…" : "ADD TO COOKBOOK"}
                  </button>
                  <p class="hint">
                    saves unpromoted: choosable from the cookbook, never auto-planned until you
                    promote it.
                  </p>
                </div>`
              : save !== "done" &&
                html`<p class="hint">${eligible?.reason ?? "this result is not saved"}</p>`
          }
          ${
            save === "done" &&
            html`<p class="hint" role="status">
              saved to the <a href="#/cookbook">cookbook</a>, unpromoted.
            </p>`
          }
          ${
            typeof save === "object" &&
            save !== null &&
            html`<p class="hint scanerr" role="status">${save.error}</p>`
          }
          <p class="hint">doneness is a temperature, never a clock.</p>
        </div>`
      }
    </div>
  `;
}
