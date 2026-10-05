import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { localIsoDate } from "../lib/dates.js";
import { purchaseEntry } from "../lib/money.js";

// HOUSE MONEY, CONFIRMED ONLY (David, 2026-10-05, zermatt): the balance moves
// when a person says who paid and how much, from the receipt or the Zelle.
// Meal records only weight a trip's split ("pay for what you eat"); a
// shelf-price guess is never a debt. Two forms a stranger can use, a list of
// recent records with a remove for typos, and SETTLED for a clean slate.

/**
 * @param {{
 *   me: string,
 *   members: string[],
 *   nameOf: (id: string) => string,
 *   balances: { profileId: string, net: number, entries: number, estimate: boolean }[],
 *   recent: import("../lib/money.js").LedgerEntry[],
 *   weightsFor: (date: string) => Record<string, number>,
 *   onPurchase: (a: { payerId: string, total: number, date: string, split: "eaten" | "even" }) => void,
 *   onPayment: (a: { fromId: string, toId: string, total: number, date: string }) => void,
 *   onRemove: (id: string) => void,
 *   onSettle?: (other: string) => void,
 * }} props
 */
export function MoneyCard({
  me,
  members,
  nameOf,
  balances,
  recent,
  weightsFor,
  onPurchase,
  onPayment,
  onRemove,
  onSettle = undefined,
}) {
  const others = members.filter((id) => id !== me);
  const [open, setOpen] = useState(/** @type {"" | "purchase" | "payment"} */ (""));
  // no default payer: a forgotten picker would flip the balance's sign
  const [payer, setPayer] = useState("");
  const [to, setTo] = useState(others[0] ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(localIsoDate(new Date()));
  const [split, setSplit] = useState(/** @type {"eaten" | "even"} */ ("eaten"));
  if (others.length === 0) return null;

  const total = Math.round(Number(String(amount).replace(/[$,\s]/g, "")) * 100) / 100;
  const dateOk = /^\d{4}-\d\d-\d\d$/.test(date);
  const who = (/** @type {string} */ id) => (id === me ? "you" : nameOf(id));
  const reset = () => {
    setOpen("");
    setPayer("");
    setAmount("");
    setSplit("eaten");
    setDate(localIsoDate(new Date()));
  };

  const preview =
    open === "purchase" && total > 0 && payer && dateOk
      ? purchaseEntry({
          id: "preview",
          date,
          payerId: payer,
          total,
          split,
          weights: weightsFor(date),
          members,
        })
      : null;
  const noMeals =
    open === "purchase" && total > 0 && payer && dateOk && split === "eaten" && !preview;

  return html`<div class="tile" role="status">
    <div class="k">💰 house money · confirmed payments only</div>
    ${balances.length === 0 &&
    html`<p class="hint">All square: nothing confirmed is owed.</p>`}
    ${balances.map(
      (b) => html`<div class="row" key=${b.profileId}>
        <span class="k num">
          ${b.net > 0 ? `${nameOf(b.profileId)} owes you` : `you owe ${nameOf(b.profileId)}`}
          ${" "}$${Math.abs(b.net).toFixed(2)}
          <small> · ${b.entries} record${b.entries === 1 ? "" : "s"}</small>
        </span>
        ${onSettle &&
        html`<button class="secondary" onClick=${() => onSettle(b.profileId)}>SETTLED</button>`}
      </div>`,
    )}
    ${open === "" &&
    html`<div class="actions wrap">
      <button class="secondary" onClick=${() => setOpen("purchase")}>WE BOUGHT GROCERIES</button>
      <button
        class="secondary"
        onClick=${() => {
          setTo(others[0] ?? "");
          setOpen("payment");
        }}
      >
        I PAID SOMEONE BACK
      </button>
    </div>`}
    ${open === "purchase" &&
    html`<div class="money-form">
      <label
        >Who paid?
        <select
          aria-label="Who paid"
          value=${payer}
          onInput=${(/** @type {any} */ e) => setPayer(e.currentTarget.value)}
        >
          <option value="" disabled>choose…</option>
          ${members.map((id) => html`<option value=${id}>${who(id)}</option>`)}
        </select>
      </label>
      <label
        >Receipt total $
        <input
          aria-label="Receipt total"
          inputmode="decimal"
          placeholder="74.33"
          value=${amount}
          onInput=${(/** @type {any} */ e) => setAmount(e.currentTarget.value)}
        />
      </label>
      <label
        >Date
        <input
          aria-label="Trip date"
          type="date"
          value=${date}
          onInput=${(/** @type {any} */ e) => setDate(e.currentTarget.value)}
        />
      </label>
      <label
        >Split
        <select
          aria-label="Split"
          value=${split}
          onInput=${(/** @type {any} */ e) => setSplit(e.currentTarget.value)}
        >
          <option value="eaten">by what each of us eats</option>
          <option value="even">evenly</option>
        </select>
      </label>
      ${preview &&
      html`<p class="hint">
        ${Object.entries(preview.shares)
          .filter(([id]) => id !== payer)
          .map(([id, v]) => `${who(id)} ${id === me ? "owe" : "owes"} ${who(payer)} $${v.toFixed(2)}`)
          .join(", ")}
      </p>`}
      ${noMeals &&
      html`<p class="hint">
        No shared meals that week to split by. Pick "evenly", or this was a personal trip and
        nobody owes anything.
      </p>`}
      <div class="actions wrap">
        <button
          disabled=${!preview}
          onClick=${() => {
            onPurchase({ payerId: payer, total, date, split });
            reset();
          }}
        >
          SAVE
        </button>
        <button class="secondary" onClick=${reset}>CANCEL</button>
      </div>
    </div>`}
    ${open === "payment" &&
    html`<div class="money-form">
      <label
        >You paid
        <select
          aria-label="Paid to"
          value=${to}
          onInput=${(/** @type {any} */ e) => setTo(e.currentTarget.value)}
        >
          ${others.map((id) => html`<option value=${id}>${nameOf(id)}</option>`)}
        </select>
      </label>
      <label
        >Amount $
        <input
          aria-label="Amount paid back"
          inputmode="decimal"
          placeholder="40"
          value=${amount}
          onInput=${(/** @type {any} */ e) => setAmount(e.currentTarget.value)}
        />
      </label>
      <label
        >Date
        <input
          aria-label="Payment date"
          type="date"
          value=${date}
          onInput=${(/** @type {any} */ e) => setDate(e.currentTarget.value)}
        />
      </label>
      <div class="actions wrap">
        <button
          disabled=${!(total > 0) || !to || !dateOk}
          onClick=${() => {
            onPayment({ fromId: me, toId: to, total, date });
            reset();
          }}
        >
          SAVE
        </button>
        <button class="secondary" onClick=${reset}>CANCEL</button>
      </div>
    </div>`}
    ${recent.length > 0 &&
    html`<div class="money-recent">
      ${recent.map(
        (e) => html`<div class="row" key=${e.id}>
          <small class="num">
            ${e.date.slice(5)} ·
            ${e.kind === "payment"
              ? `${who(e.payerId)} paid ${who(e.toId ?? "")} back $${e.total.toFixed(2)}`
              : `${who(e.payerId)} paid $${e.total.toFixed(2)} for groceries${e.split === "even" ? " (even split)" : ""}`}
          </small>
          <button
            class="secondary"
            aria-label="Remove this record"
            onClick=${() => onRemove(e.id)}
          >
            ✕
          </button>
        </div>`,
      )}
    </div>`}
    <p class="hint">
      Only real money counts: what the receipt says and who paid it, and every payback. A trip
      splits by what each of you eats from the shared meals that week, never an automatic even
      split. Settle in the real world (Zelle, cash), then record it here or tap SETTLED.
    </p>
  </div>`;
}
