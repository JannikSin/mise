import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { readProfiles, write } from "../lib/store.js";
import { targetsFromQuestionnaire } from "../lib/fitness.js";
import { localIsoDate } from "../lib/dates.js";

/**
 * Full-screen profile chooser: shown by main.js when localStorage's
 * mise.activeProfile is unset (fresh install, or after System's "switch
 * profile" clears it). Tapping a profile sets the key and reloads — same
 * clean pattern as token entry — so every scoped read/write re-derives from
 * the new value on next boot.
 *
 * ADD PROFILE is a questionnaire, not a bare name field: height/weight/age/
 * activity/goal feed targetsFromQuestionnaire (Mifflin-St Jeor) so the new
 * profile boots with working macro targets, meal slots, and Daily Dozen —
 * no Claude session required to onboard a household member. Recipes come
 * from the shared bank (phases-filtered), so an empty profiles/<id>/recipes/
 * is a working state, not a broken one.
 * @returns {import("preact").VNode}
 */
export function ProfileGateView() {
  const [profiles, setProfiles] = useState(/** @type {Record<string, any>[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [sex, setSex] = useState(/** @type {"m" | "f"} */ ("f"));
  const [age, setAge] = useState("");
  const [heightFt, setHeightFt] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [weightLb, setWeightLb] = useState("");
  const [activity, setActivity] = useState(2);
  const [goal, setGoal] = useState(/** @type {"loss" | "maintain" | "gain"} */ ("maintain"));
  const [training, setTraining] = useState(true);
  const [saving, setSaving] = useState(false);

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

  const numeric = {
    age: Number(age),
    heightFt: Number(heightFt),
    heightIn: heightIn.trim() === "" ? 0 : Number(heightIn),
    weightLb: Number(weightLb),
  };
  const formValid =
    name.trim() &&
    emoji.trim() &&
    numeric.age >= 10 &&
    numeric.age <= 100 &&
    numeric.heightFt >= 3 &&
    numeric.heightFt <= 7 &&
    numeric.heightIn >= 0 &&
    numeric.heightIn < 12 &&
    numeric.weightLb >= 60 &&
    numeric.weightLb <= 500;

  const addProfile = async () => {
    if (!formValid || saving) return;
    const trimmedName = name.trim();
    const id = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id || profiles.some((p) => p.id === id)) return;
    setSaving(true);
    const targets = targetsFromQuestionnaire(
      {
        sex,
        age: numeric.age,
        heightFt: numeric.heightFt,
        heightIn: numeric.heightIn,
        weightLb: numeric.weightLb,
        activity: /** @type {1|2|3|4|5} */ (activity),
        goal,
      },
      localIsoDate(new Date()),
    );
    const next = {
      profiles: [
        ...profiles,
        {
          id,
          name: trimmedName,
          emoji: emoji.trim(),
          phase: targets.phase,
          trainingEnabled: training,
        },
      ],
    };
    // await the cache writes (not the network flush, which queues and
    // survives fine) so the reload below never races the local records.
    // Both paths are raw: the gate runs BEFORE a profile is chosen, so
    // scoping must not apply. profiles.json is never scoped anyway.
    await write(`profiles/${id}/fitness/targets.json`, targets, { raw: true });
    await write("profiles.json", next);
    choose(id);
  };

  const num = (/** @type {(v: string) => void} */ set) => (/** @type {any} */ e) =>
    set(e.currentTarget.value.replace(/[^0-9]/g, ""));

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

          <h2 class="block-title">about them</h2>
          <div class="chips" role="group" aria-label="Sex (for calorie math)">
            <button class="chip ${sex === "f" ? "on" : ""}" onClick=${() => setSex("f")}>
              female
            </button>
            <button class="chip ${sex === "m" ? "on" : ""}" onClick=${() => setSex("m")}>
              male
            </button>
          </div>
          <div class="token-form">
            <input
              aria-label="Age in years"
              placeholder="age"
              inputmode="numeric"
              value=${age}
              onInput=${num(setAge)}
            />
            <input
              aria-label="Height feet"
              placeholder="ft"
              inputmode="numeric"
              value=${heightFt}
              onInput=${num(setHeightFt)}
            />
            <input
              aria-label="Height inches"
              placeholder="in"
              inputmode="numeric"
              value=${heightIn}
              onInput=${num(setHeightIn)}
            />
            <input
              aria-label="Weight in pounds"
              placeholder="lb"
              inputmode="numeric"
              value=${weightLb}
              onInput=${num(setWeightLb)}
            />
          </div>

          <h2 class="block-title">how active</h2>
          <div class="chips wrapchips" role="group" aria-label="Activity level">
            ${["desk job", "light", "moderate", "very", "athlete"].map(
              (label, i) => html`
                <button
                  class="chip ${activity === i + 1 ? "on" : ""}"
                  key=${label}
                  onClick=${() => setActivity(i + 1)}
                >
                  ${label}
                </button>
              `,
            )}
          </div>

          <h2 class="block-title">goal</h2>
          <div class="chips" role="group" aria-label="Goal">
            <button class="chip ${goal === "loss" ? "on" : ""}" onClick=${() => setGoal("loss")}>
              lose
            </button>
            <button
              class="chip ${goal === "maintain" ? "on" : ""}"
              onClick=${() => setGoal("maintain")}
            >
              maintain
            </button>
            <button class="chip ${goal === "gain" ? "on" : ""}" onClick=${() => setGoal("gain")}>
              gain
            </button>
          </div>

          <h2 class="block-title">training features?</h2>
          <div class="chips" role="group" aria-label="Do you want training features?">
            <button class="chip ${training ? "on" : ""}" onClick=${() => setTraining(true)}>
              yes
            </button>
            <button class="chip ${!training ? "on" : ""}" onClick=${() => setTraining(false)}>
              no
            </button>
          </div>
          <p class="hint">no hides the Train tab and workout tracking — flip it later in SYS.</p>

          <div class="actions">
            <button class="primary" onClick=${addProfile} disabled=${!formValid || saving}>
              ${saving ? "SETTING UP…" : "ADD & OPEN"}
            </button>
          </div>
          <p class="hint">
            ADD lights up when everything is filled in: name, emoji, age 10-100, height 3-7 ft
            (inches 0-11), weight 60-500 lb.
          </p>
          <p class="hint">
            calories and protein are computed from these answers (Mifflin-St Jeor); recipes come
            from the shared bank matched to the goal. Everything is adjustable later in SYS.
          </p>
        </div>
      </details>
    </div>
  `;
}
