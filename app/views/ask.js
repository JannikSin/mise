import { html } from "htm/preact";
import { tokenBroken } from "../lib/github.js";
import { useState } from "preact/hooks";
import { askTurn } from "../lib/worker.js";

/**
 * ASK — the general question box (David, 2026-08-03: "I need a chat so I can
 * ask questions on the app where all of the context is"). One thread, no
 * history persisted anywhere: the value is the live context snapshot main.js
 * composes (targets, today's meals, the week's dinners with cooks and
 * buyers, the kitchen, the list), not the transcript. It answers; it never
 * edits data.
 * @param {{
 *   context: Record<string, any>,
 *   hasToken: boolean,
 *   repo: Record<string, any> | null
 * }} props
 */
export function AskView({ context, hasToken, repo }) {
  const [chat, setChat] = useState(/** @type {{ role: string, content: string }[]} */ ([]));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tokenBlocked = !hasToken || tokenBroken(repo?.auth);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError("");
    const messages = [...chat, { role: "user", content: text }];
    setChat(messages);
    setBusy(true);
    try {
      const { reply } = await askTurn(messages, context);
      setChat([...messages, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "no answer — try again with signal");
    }
    setBusy(false);
  };

  return html`
    <div class="view">
      <a class="backlink" href="#/tables">← TODAY</a>
      <div class="hero"><h1>Ask</h1></div>
      <p class="hint">
        Questions about your food, answered with your live context: today's meals, the family
        dinners and who cooks and buys them, what's in the kitchen, your list. "How do I batch-cook
        the chicken?" is exactly what this is for. It explains — it never changes anything.
      </p>
      ${
        tokenBlocked &&
        html`<p class="hint">
          ${tokenBroken(repo?.auth) ? "token needs fixing — Settings" : "connect token in Settings first"}
        </p>`
      }
      ${chat.map(
        (m, i) => html`
          <div class="tile ${m.role === "assistant" ? "buildreport" : ""}" key=${i}>
            <div class="k">${m.role === "assistant" ? "Mise" : "You"}</div>
            <div class="d">${m.content}</div>
          </div>
        `,
      )}
      ${busy && html`<p class="hint" role="status">thinking…</p>`}
      ${error && html`<p class="hint scanerr" role="status">${error}</p>`}
      <div class="token-form">
        <input
          aria-label="Your question"
          placeholder=${chat.length === 0 ? "e.g. how do I batch-cook the chicken?" : "follow up…"}
          value=${draft}
          disabled=${tokenBlocked}
          onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
            setDraft(e.currentTarget.value)}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button class="primary" disabled=${busy || tokenBlocked} onClick=${() => void send()}>
          ASK
        </button>
      </div>
    </div>
  `;
}
