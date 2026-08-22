import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { onboardTurn } from "../lib/worker.js";
import { readProfiles, patchProfiles, writeTargetsOf, flushNow } from "../lib/store.js";
import { targetsFromQuestionnaire } from "../lib/targets.js";
import { normalizeEquipment } from "../lib/equipment.js";
import { localIsoDate } from "../lib/dates.js";

/**
 * Turn the onboarder's finished raw answers into a profiles.json entry + a
 * fitness/targets.json, using the SAME deterministic Mifflin-St Jeor math as
 * the survey gate (the model never computes macros). Returns the new id.
 * @param {Record<string, any>} p validated onboard profile
 * @param {Record<string, any>[]} existing current profiles
 * @returns {Promise<{ id: string, synced: boolean, syncError: string | null, pending: number } | null>} null if the name collides / is empty
 */
async function finalizeProfile(p, existing) {
  const id = String(p.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || existing.some((x) => x.id === id)) return null;
  const targets = targetsFromQuestionnaire(
    {
      sex: p.sex,
      age: p.age,
      heightFt: p.heightFt,
      heightIn: p.heightIn,
      weightLb: p.weightLb,
      activity: p.activity,
      goal: p.goal,
    },
    localIsoDate(new Date()),
    {
      diet: p.diet,
      allergensFreeText: p.allergensFreeText,
      dislikeIngredients: p.dislikeIngredients,
      tiredOf: p.tiredOf,
      cuisinePrefs: { loved: p.lovedCuisines ?? [], avoided: p.avoidedCuisines ?? [] },
      budget: p.budget,
      stores: p.stores,
      ...(p.maxWeeknightMinutes ? { maxWeeknightMinutes: p.maxWeeknightMinutes } : {}),
      leftoverTolerance: p.leftoverTolerance,
      packsLunch: p.packsLunch,
      lunchMicrowave: p.lunchMicrowave,
      skipBreakfast: p.skipBreakfast,
      smoothie: p.smoothie,
      state: p.state,
      // 2026-08-22: the survey had gone stale against three shipped systems
      // and asked about none of them. UNDECLARED equipment stays undeclared,
      // because absent means "offer everything" while an empty array means
      // "this kitchen has nothing", and collapsing them empties a week.
      ...(Array.isArray(p.equipment) ? { equipment: normalizeEquipment(p.equipment) } : {}),
      ...(p.mealsOutPerWeek != null ? { mealsOutPerWeek: p.mealsOutPerWeek } : {}),
      ...(p.shopsPerWeek != null ? { shopsPerWeek: p.shopsPerWeek } : {}),
    },
  );
  const entry = {
    id,
    name: p.name,
    emoji: p.emoji || "🙂",
    phase: targets.phase,
    ...(p.household && p.household.toLowerCase() !== "home"
      ? {
          household: p.household
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, ""),
        }
      : {}),
    ...(p.family
      ? {
          family: String(p.family)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, ""),
        }
      : {}),
  };
  // things the questionnaire math does not own, written onto the same
  // targets document the rest of the app reads
  if (p.weeklyBudgetUsd != null) targets.weeklyBudgetUsd = p.weeklyBudgetUsd;
  if (p.diningSwipesPerWeek) {
    targets.currencies = [
      {
        id: "swipes",
        name: "Dining swipes",
        unit: "swipe",
        perWeek: p.diningSwipesPerWeek,
        expires: p.diningSwipesExpire === "semester" ? "semester" : "weekly",
        venue: "buffet",
        toGo: true,
      },
    ];
  }
  await writeTargetsOf(id, targets);
  // G2: append against the REAL list via the safe path — never a whole-array
  // replacement from this component's snapshot (that's the clobber bug)
  let duped = false;
  const ok = await patchProfiles(
    (list) => {
      if (list.some((x) => x.id === id)) {
        duped = true;
        return list;
      }
      return [...list, entry];
    },
    { allowSeed: true },
  );
  if (!ok || duped) return null;

  // AND THEN CONFIRM IT ACTUALLY LEFT THE PHONE.
  // Both writes above resolve as soon as they are QUEUED, which is right for
  // a shopping list in a store with no signal and wrong for the end of a
  // sign-up. Without this the survey says "you're set" while the profile
  // exists only in this browser's IndexedDB, which is exactly how a
  // roommate's profile was lost: he saw a working app and the repo never
  // heard of him. The profile is still safe locally either way — the caller
  // is told the truth so it can say so, not so it can discard anything.
  const sync = await flushNow();
  return { id, synced: sync.landed, syncError: sync.error, pending: sync.pending };
}

/**
 * Chat onboarder: a short conversation that fills a new profile, then writes
 * it and drops into the app. The gate survey (passed as `survey`) is handed to
 * the model as already-known context so the chat stays a few turns / a few
 * cents. Requires the Worker AI key; without it every turn 503s and the view
 * points back at the survey.
 * @param {{ survey?: Record<string, any>, hasToken: boolean }} props
 * @returns {import("preact").VNode}
 */
export function OnboardView({ survey = {}, hasToken }) {
  const [msgs, setMsgs] = useState(
    /** @type {{ role: "user" | "assistant", content: string }[]} */ ([]),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const scroller = useRef(/** @type {HTMLDivElement | null} */ (null));

  // kick off: ask the model for its opening line from an empty-but-primed turn
  useEffect(() => {
    let alive = true;
    if (!hasToken) return;
    setBusy(true);
    onboardTurn([{ role: "user", content: "Hi, I'd like to set up my Mise profile." }], survey)
      .then((r) => {
        if (!alive) return;
        setMsgs([
          { role: "user", content: "Hi, I'd like to set up my Mise profile." },
          { role: "assistant", content: r.reply || "Hi! What should I call you?" },
        ]);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "onboarder unavailable"))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // survey is stable for the life of the view
  }, [hasToken]);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [msgs]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || saving) return;
    setDraft("");
    setError("");
    const next = [...msgs, /** @type {const} */ ({ role: "user", content: text })];
    setMsgs(next);
    setBusy(true);
    try {
      const r = await onboardTurn(next, survey);
      if (r.profile) {
        setSaving(true);
        const { profiles } = await readProfiles();
        const made = await finalizeProfile(r.profile, profiles);
        if (!made) {
          setError("that name is already taken by another profile — try a different one");
          setSaving(false);
          setBusy(false);
          return;
        }
        // SAY WHICH IT WAS. A profile that only exists on this phone is a
        // real state, and pretending otherwise is what lost the last one.
        setMsgs([
          ...next,
          {
            role: "assistant",
            content: made.synced
              ? `All set, ${r.profile.name}. Your profile is saved and synced. Opening your Mise…`
              : `Saved on THIS DEVICE, ${r.profile.name}, but it has not reached the shared data repo yet` +
                `${made.syncError ? ` (${made.syncError})` : ""}. ` +
                `Nothing is lost and it will sync itself once that is fixed — but do NOT reinstall the app ` +
                `or change the data repo until it has, because this is the only copy. Opening your Mise…`,
          },
        ]);
        localStorage.setItem("mise.activeProfile", made.id);
        // an unsynced profile gets longer on screen, because the warning is
        // the whole point of showing it
        setTimeout(() => location.reload(), made.synced ? 900 : 6000);
        return;
      }
      setMsgs([...next, { role: "assistant", content: r.reply || "…" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "message failed");
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="view">
      <div class="hero"><h1>Set up by chat</h1></div>
      ${
        !hasToken &&
        html`<div class="empty">
          the chat setup needs the app's AI key — for now use
          <a href="#/">the survey on the profile screen</a>.
        </div>`
      }
      ${
        hasToken &&
        html`
          <div class="chat-scroll" ref=${scroller}>
            ${msgs
              .filter((m, i) => !(i === 0 && m.role === "user"))
              .map((m, i) => html`<div class="bubble ${m.role}" key=${i}>${m.content}</div>`)}
            ${busy && html`<div class="bubble assistant dim">…</div>`}
          </div>
          ${error && html`<p class="hint">${error}</p>`}
          <div class="token-form chat-input">
            <input
              aria-label="Your reply"
              placeholder=${saving ? "setting up…" : "type your answer"}
              value=${draft}
              disabled=${busy || saving}
              onInput=${(/** @type {any} */ e) => setDraft(e.currentTarget.value)}
              onKeyDown=${(/** @type {any} */ e) => e.key === "Enter" && send()}
            />
            <button class="primary" onClick=${send} disabled=${busy || saving || !draft.trim()}>
              SEND
            </button>
          </div>
          <p class="hint">
            answers you gave on the survey are already known — this just fills the gaps.
          </p>
        `
      }
    </div>
  `;
}
