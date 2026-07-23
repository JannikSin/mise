import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { dinnerTurn } from "../lib/worker.js";

/**
 * Dinner discussion: everyone at the table says what they feel like, the
 * mediator weighs every voice against each person's goal and targets, then
 * either picks from the shared bank or proposes one special meal. Applying
 * the decision sets a real table for tonight's dinner (the whole existing
 * table machinery — seats, plan derivation, shopping — takes it from there).
 * @param {{
 *   profiles: Record<string, any>[],
 *   me: string,
 *   bankRecipes: Record<string, any>[],
 *   hasToken: boolean,
 *   repo: Record<string, any> | null,
 *   onDinerFacts: (ids: string[]) => Promise<Record<string, any>[]>,
 *   onApplyDinner: (decision: Record<string, any>, participantIds: string[]) => Promise<void>
 * }} props
 */
export function DinnerView({
  profiles,
  me,
  bankRecipes,
  hasToken,
  repo,
  onDinerFacts,
  onApplyDinner,
}) {
  const myHouse = (profiles ?? []).find((p) => p.id === me)?.household ?? "home";
  const housemates = (profiles ?? []).filter((p) => (p.household ?? "home") === myHouse);
  // profiles load async after mount, so "everyone in by default" is derived
  // live; state tracks only who was deliberately toggled OUT
  const [unpicked, setUnpicked] = useState(/** @type {string[]} */ ([]));
  const picked = housemates
    .map((p) => /** @type {string} */ (p.id))
    .filter((id) => !unpicked.includes(id));
  const [says, setSays] = useState(/** @type {Record<string, string>} */ ({}));
  const [chat, setChat] = useState(/** @type {{ role: string, content: string }[]} */ ([]));
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [decision, setDecision] = useState(/** @type {Record<string, any> | null} */ (null));
  const [applied, setApplied] = useState(false);
  const tokenBlocked = !hasToken || repo?.auth === "invalid";

  const toggle = (/** @type {string} */ id) =>
    setUnpicked(unpicked.includes(id) ? unpicked.filter((p) => p !== id) : [...unpicked, id]);
  const nameOf = (/** @type {string} */ id) =>
    (profiles ?? []).find((p) => p.id === id)?.name ?? id;

  // compact candidate list: the profile-visible dinner bank
  const candidates = (bankRecipes ?? [])
    .filter((r) => r.mealType === "dinner")
    .map((r) => ({
      id: r.id,
      name: r.name,
      calories: r.nutrition?.calories ?? 0,
      protein: r.nutrition?.protein ?? 0,
      cuisine: r.cuisine ?? "",
    }));

  const runTurn = async (/** @type {{ role: string, content: string }[]} */ messages) => {
    setBusy(true);
    setError("");
    try {
      const facts = await onDinerFacts(picked);
      const people = facts.map((f) => ({ ...f, say: (says[f.id] ?? "").trim() }));
      const turn = await dinnerTurn(messages, /** @type {any} */ (people), candidates);
      setChat(turn.reply ? [...messages, { role: "assistant", content: turn.reply }] : messages);
      if (turn.decision) setDecision(turn.decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "no answer — try again with signal");
    }
    setBusy(false);
  };

  const start = () => {
    const opening = picked
      .map((id) => `${nameOf(id)}: ${(says[id] ?? "").trim() || "no preference"}`)
      .join("\n");
    void runTurn([
      { role: "user", content: `Tonight's asks:\n${opening}\n\nWhat should dinner be?` },
    ]);
  };

  const send = () => {
    const text = followUp.trim();
    if (!text) return;
    setFollowUp("");
    setDecision(null); // a new message reopens the discussion
    void runTurn([...chat, { role: "user", content: text }]);
  };

  const apply = async () => {
    if (!decision) return;
    setBusy(true);
    setError("");
    try {
      await onApplyDinner(decision, picked);
      setApplied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not set the table — try again");
    }
    setBusy(false);
  };

  const pickedRecipe = decision?.pickRecipeId
    ? (bankRecipes ?? []).find((r) => r.id === decision.pickRecipeId)
    : null;
  const chosenName = pickedRecipe?.name ?? decision?.special?.name ?? "";
  const chosenN = pickedRecipe?.nutrition ?? decision?.special?.nutrition ?? null;

  return html`
    <div class="view">
      <a class="backlink" href="#/today">← COOK</a>
      <div class="hero"><h1>Tonight's dinner</h1></div>
      <p class="hint">
        everyone gets a say — the mediator weighs each voice against their targets, then picks from
        the bank or invents one special meal. Applying it sets a real table for tonight.
      </p>

      ${
        chat.length === 0 &&
        html`
          <h2 class="block-title">Who's eating</h2>
          <div class="chips wrapchips" role="group" aria-label="Who's eating">
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

          <h2 class="block-title">Everyone's say</h2>
          ${picked.map(
            (id) => html`
              <div class="token-form" key=${id}>
                <span class="hint saylabel" aria-hidden="true">${nameOf(id)}</span>
                <input
                  aria-label="What ${nameOf(id)} feels like tonight"
                  placeholder="e.g. something spicy, no beans please"
                  value=${says[id] ?? ""}
                  onInput=${(/** @type {any} */ e) =>
                    setSays({ ...says, [id]: e.currentTarget.value })}
                />
              </div>
            `,
          )}
          <div class="actions">
            <button
              class="ask"
              disabled=${busy || picked.length === 0 || tokenBlocked}
              onClick=${start}
            >
              ${busy ? "WEIGHING THE VOICES…" : "💬 TALK IT OUT"}
              <small>the mediator hears everyone and proposes dinner</small>
            </button>
          </div>
          ${
            tokenBlocked &&
            html`<p class="hint">
              ${repo?.auth === "invalid" ? "token needs renewing — SYS" : "connect token in SYS first"}
            </p>`
          }
        `
      }
      ${chat
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m, i) => html`<div class="tile" key=${i}><div class="d">${m.content}</div></div>`)}
      ${
        decision &&
        html`<div class="tile buffer" role="status">
          <div class="k">🍽 proposal</div>
          <div class="d">
            <b>${chosenName}</b>
            ${
              chosenN &&
              html`<span class="num">
                · ${chosenN.calories} kcal · ${chosenN.protein}P / serving</span
              >`
            }
            ${decision.special && html`<span class="usesoon">special · new recipe</span>`}
          </div>
          ${decision.why && html`<div class="hint">${decision.why}</div>`}
          ${(decision.plates ?? []).map(
            (/** @type {any} */ p) => html`
              <div class="d" key=${p.id}>
                ${nameOf(p.id)}: ${p.note || "as served"}
                <span class="num"> · ~${p.estCalories} kcal · ${p.estProtein}P</span>
              </div>
            `,
          )}
          ${
            !applied &&
            html`<div class="actions">
              <button class="primary" disabled=${busy} onClick=${apply}>
                ${busy ? "SETTING…" : "SET THE TABLE ✓"}
              </button>
            </div>`
          }
          ${
            applied &&
            html`<div class="d">
              ✓ table set for tonight — it's on <a href="#/plan">Plan</a> and everyone's day replans
              around it.
            </div>`
          }
        </div>`
      }
      ${
        chat.length > 0 &&
        !applied &&
        html`<div class="token-form">
          <input
            aria-label="Answer or push back"
            placeholder=${decision ? "not feeling it? say so" : "answer here"}
            value=${followUp}
            onInput=${(/** @type {any} */ e) => setFollowUp(e.currentTarget.value)}
          />
          <button
            class="primary"
            disabled=${busy || !followUp.trim() || tokenBlocked}
            onClick=${send}
          >
            ${busy ? "…" : "SEND"}
          </button>
        </div>`
      }
      ${error && html`<p class="hint scanerr" role="status">${error}</p>`}
    </div>
  `;
}
