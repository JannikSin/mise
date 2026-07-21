import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { readProfiles, patchProfiles, write } from "../lib/store.js";
import { getToken } from "../lib/github.js";
import { targetsFromQuestionnaire } from "../lib/fitness.js";
import { localIsoDate } from "../lib/dates.js";
import { OnboardView } from "./onboard.js";

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
/** Allergen preset ids — must match ALLERGEN_TERMS keys in app/lib/fitness.js. */
const ALLERGEN_PRESETS = [
  "nuts",
  "peanuts",
  "gluten",
  "dairy",
  "eggs",
  "soy",
  "shellfish",
  "fish",
  "sesame",
];
/** Trackable kitchen equipment (survey-v2 Q16); absent from profile = has everything. */
const EQUIPMENT = ["blender", "oven", "rice cooker", "food processor", "freezer"];
/** Chip grid for cuisine loves/avoids (survey-v2 Q14) — the bank's common cuisines. */
const CUISINES = [
  "american",
  "italian",
  "japanese",
  "chinese",
  "korean",
  "mexican",
  "indian",
  "mediterranean",
  "middle-eastern",
  "french",
  "thai",
];

/** Split a comma-separated free-text field into a trimmed, non-empty list. */
function splitList(/** @type {string} */ s) {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function ProfileGateView() {
  const [profiles, setProfiles] = useState(/** @type {Record<string, any>[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [fallback, setFallback] = useState(false);
  const [saveErr, setSaveErr] = useState("");
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
  const [chatMode, setChatMode] = useState(false);

  // survey-v2 section 2 (required, but every answer has a safe default)
  const [diet, setDiet] = useState(
    /** @type {"omnivore" | "pescatarian" | "vegetarian" | "vegan"} */ ("omnivore"),
  );
  const [allergens, setAllergens] = useState(/** @type {string[]} */ ([]));
  const [allergensFreeText, setAllergensFreeText] = useState("");
  const [skipBreakfast, setSkipBreakfast] = useState(false);
  const [smoothie, setSmoothie] = useState(true);
  const [snackAppetite, setSnackAppetite] = useState(/** @type {"grazer" | "meals"} */ ("grazer"));
  const [maxWeeknightMinutes, setMaxWeeknightMinutes] = useState(
    /** @type {number | null} */ (null),
  );

  // survey-v2 section 3 (optional, skippable)
  const [dislikes, setDislikes] = useState("");
  const [cuisinePrefs, setCuisinePrefs] = useState(
    /** @type {Record<string, "loved" | "avoided">} */ ({}),
  );
  const [maxDifficulty, setMaxDifficulty] = useState(/** @type {1 | 2 | 3} */ (3));
  const [equipment, setEquipment] = useState(/** @type {string[]} */ ([...EQUIPMENT]));
  const [breakfastStyle, setBreakfastStyle] = useState(
    /** @type {"sweet" | "savory" | "grab-and-go" | "surprise"} */ ("surprise"),
  );
  const [budget, setBudget] = useState(/** @type {"tight" | "normal" | "loose"} */ ("normal"));
  const [stores, setStores] = useState("");
  const [shopsPerWeek, setShopsPerWeek] = useState(1);
  // richer-survey additions (2026-07-19): shorten the chat onboarder to pennies
  const [household, setHousehold] = useState("home");
  // family layer (2026-07-21): family = who you ARE (the gate groups by it);
  // household = who you shop with right now (movable in SYS)
  const [family, setFamily] = useState("");
  // typical restaurant/free meals per week — pre-fills nothing yet, but the
  // assistant and the OUT-slot suggestions will read it (targets.mealsOutPerWeek)
  const [mealsOut, setMealsOut] = useState(0);
  const [usState, setUsState] = useState("");
  const [tiredOf, setTiredOf] = useState("");
  const [leftoverTolerance, setLeftoverTolerance] = useState(
    /** @type {"none" | "some" | "lots"} */ ("some"),
  );
  const [packsLunch, setPacksLunch] = useState(false);
  const [lunchMicrowave, setLunchMicrowave] = useState(false);

  const toggleIn = (/** @type {string[]} */ list, /** @type {string} */ v) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const cycleCuisine = (/** @type {string} */ c) =>
    setCuisinePrefs((prev) => {
      const next = { ...prev };
      if (!next[c]) {
        if (Object.values(next).filter((v) => v === "loved").length >= 3) return prev; // max 3 loves
        next[c] = "loved";
      } else if (next[c] === "loved") next[c] = "avoided";
      else delete next[c];
      return next;
    });

  useEffect(() => {
    let alive = true;
    readProfiles().then((p) => {
      if (!alive) return;
      setProfiles(p.profiles);
      setFallback(Boolean(/** @type {any} */ (p).fallback));
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
    setSaveErr("");
    const loved = Object.keys(cuisinePrefs).filter((c) => cuisinePrefs[c] === "loved");
    const avoided = Object.keys(cuisinePrefs).filter((c) => cuisinePrefs[c] === "avoided");
    const equipAll = EQUIPMENT.every((e) => equipment.includes(e));
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
      {
        diet,
        allergens,
        allergensFreeText,
        skipBreakfast,
        smoothie,
        snackAppetite,
        ...(maxWeeknightMinutes ? { maxWeeknightMinutes } : {}),
        dislikeIngredients: splitList(dislikes),
        cuisinePrefs: { loved, avoided },
        maxDifficulty,
        // absent = has everything; only record a real limitation
        ...(equipAll ? {} : { equipment }),
        breakfastStyle,
        budget,
        stores: splitList(stores),
        shopsPerWeek,
        tiredOf: splitList(tiredOf),
        state: usState.trim().toUpperCase().slice(0, 2),
        leftoverTolerance,
        packsLunch,
        lunchMicrowave,
        ...(mealsOut > 0 ? { mealsOutPerWeek: mealsOut } : {}),
      },
    );
    const slugify = (/** @type {string} */ s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const entry = {
      id,
      name: trimmedName,
      emoji: emoji.trim(),
      phase: targets.phase,
      trainingEnabled: training,
      // "home" (or blank) is the default: store as absent, not a string
      ...(household.trim() && household.trim().toLowerCase() !== "home"
        ? { household: slugify(household) }
        : {}),
      ...(family.trim() ? { family: slugify(family) } : {}),
    };
    // await the cache writes (not the network flush, which queues and
    // survives fine) so the reload below never races the local records.
    // Both paths are raw: the gate runs BEFORE a profile is chosen, so
    // scoping must not apply. profiles.json is never scoped anyway.
    await write(`profiles/${id}/fitness/targets.json`, targets, { raw: true });
    // G2: append against the REAL list, never this component's snapshot —
    // a device that hadn't synced used to erase every profile it didn't
    // know about right here. allowSeed covers the genuinely-fresh repo.
    let duped = false;
    const ok = await patchProfiles(
      (list) => {
        if (list.some((p) => p.id === id)) {
          duped = true;
          return list;
        }
        return [...list, entry];
      },
      { allowSeed: true },
    );
    if (!ok) {
      setSaving(false);
      setSaveErr(
        "couldn't load the existing profile list (offline or token not set), so nothing was written: creating now could erase profiles this device hasn't seen. Get online once, then retry.",
      );
      return;
    }
    if (duped) {
      setSaving(false);
      setSaveErr(`a profile with the id "${id}" already exists, pick a different name.`);
      return;
    }
    choose(id);
  };

  const num = (/** @type {(v: string) => void} */ set) => (/** @type {any} */ e) =>
    set(e.currentTarget.value.replace(/[^0-9]/g, ""));

  // whatever the user typed on the survey is handed to the chat onboarder as
  // already-known context, so the conversation only fills the gaps.
  const surveyContext = () => ({
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
    ...(household.trim() ? { household: household.trim() } : {}),
    ...(usState.trim() ? { state: usState.trim().toUpperCase() } : {}),
    ...(age ? { age: Number(age) } : {}),
    ...(heightFt ? { heightFt: Number(heightFt) } : {}),
    ...(weightLb ? { weightLb: Number(weightLb) } : {}),
    sex,
    goal,
    diet,
    ...(splitList(tiredOf).length ? { tiredOf: splitList(tiredOf) } : {}),
    ...(splitList(dislikes).length ? { dislikeIngredients: splitList(dislikes) } : {}),
  });

  if (chatMode) {
    return html`
      <div class="view">
        <button class="secondary linkbtn" onClick=${() => setChatMode(false)}>
          ← back to the survey
        </button>
        <${OnboardView} survey=${surveyContext()} hasToken=${Boolean(getToken())} />
      </div>
    `;
  }

  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">who's checking in?</div>
      </div>
      ${loading && html`<p class="hint">loading profiles…</p>`}
      ${
        fallback &&
        !loading &&
        html`<p class="hint">
          ⚠ couldn't load the profile list (offline or token not set), so this is the built-in
          default. Any other profiles still exist and are safe; they'll appear once this device
          syncs.
        </p>`
      }
      ${
        // family = the top-level grouping (David's structure, 2026-07-21):
        // people belong to a family; households are the movable shopping
        // unit inside SYS. Headers only appear once 2+ families exist.
        (() => {
          const famOf = (/** @type {Record<string, any>} */ p) => p.family ?? "";
          const fams = [...new Set(profiles.map(famOf))];
          const showHeaders = fams.filter(Boolean).length > 0 && fams.length > 1;
          const block = (/** @type {Record<string, any>[]} */ list) => html`
            <div class="slots">
              ${list.map(
                (p) => html`
                  <button class="ask" key=${p.id} onClick=${() => choose(p.id)}>
                    ${p.emoji} ${p.name}
                  </button>
                `,
              )}
            </div>
          `;
          if (!showHeaders) return block(profiles);
          return fams
            .sort((a, b) => (a || "zz").localeCompare(b || "zz"))
            .map(
              (f) => html`
                <div key=${f || "none"}>
                  <h2 class="block-title">${f ? f.toUpperCase() : "EVERYONE ELSE"}</h2>
                  ${block(profiles.filter((p) => famOf(p) === f))}
                </div>
              `,
            );
        })()
      }
      <button class="secondary linkbtn" onClick=${() => setChatMode(true)}>
        prefer to chat? set up by conversation →
      </button>
      <details>
        <summary class="block-title">+ add profile</summary>
        <div class="tile">
          <p class="hint">
            fill what you like here, or tap "set up by conversation" above and answer a few
            questions.
          </p>
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
          <div class="token-form">
            <input
              aria-label="Family this person belongs to"
              placeholder="family (e.g. taranowski)"
              value=${family}
              onInput=${(/** @type {any} */ e) => setFamily(e.currentTarget.value)}
            />
            <input
              aria-label="House (the kitchen they cook and shop from)"
              placeholder="house (e.g. home)"
              value=${household}
              onInput=${(/** @type {any} */ e) => setHousehold(e.currentTarget.value)}
            />
            <input
              aria-label="US state (2 letters, for grocery tax)"
              placeholder="state (IL)"
              maxlength="2"
              value=${usState}
              onInput=${(/** @type {any} */ e) => setUsState(e.currentTarget.value.toUpperCase())}
            />
          </div>
          <p class="hint">
            family is who they ARE (the chooser groups by it); a house is the kitchen they cook and
            shop with right now, movable any time in SYS. State sets the List's grocery tax.
          </p>

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

          <h2 class="block-title">what they eat</h2>
          <div class="chips wrapchips" role="group" aria-label="Dietary pattern">
            ${["omnivore", "pescatarian", "vegetarian", "vegan"].map(
              (d) => html`
                <button
                  class="chip ${diet === d ? "on" : ""}"
                  key=${d}
                  onClick=${() => setDiet(/** @type {any} */ (d))}
                >
                  ${d}
                </button>
              `,
            )}
          </div>

          <h2 class="block-title">allergies & hard no's</h2>
          <div class="chips wrapchips" role="group" aria-label="Allergies to avoid">
            ${ALLERGEN_PRESETS.map(
              (a) => html`
                <button
                  class="chip ${allergens.includes(a) ? "on" : ""}"
                  key=${a}
                  aria-pressed=${allergens.includes(a)}
                  onClick=${() => setAllergens(toggleIn(allergens, a))}
                >
                  ${a}
                </button>
              `,
            )}
          </div>
          <input
            aria-label="Anything else to avoid, comma separated"
            placeholder="anything else? e.g. cilantro, mushrooms"
            value=${allergensFreeText}
            onInput=${(/** @type {any} */ e) => setAllergensFreeText(e.currentTarget.value)}
          />

          <h2 class="block-title">meals a day</h2>
          <div class="chips wrapchips" role="group" aria-label="Meals per day">
            <button
              class="chip ${skipBreakfast ? "" : "on"}"
              aria-pressed=${!skipBreakfast}
              onClick=${() => setSkipBreakfast(false)}
            >
              eat breakfast
            </button>
            <button
              class="chip ${skipBreakfast ? "on" : ""}"
              aria-pressed=${skipBreakfast}
              onClick=${() => setSkipBreakfast(true)}
            >
              skip breakfast
            </button>
            <button
              class="chip ${smoothie ? "on" : ""}"
              aria-pressed=${smoothie}
              onClick=${() => setSmoothie(!smoothie)}
            >
              daily smoothie
            </button>
          </div>
          <div class="chips" role="group" aria-label="Snacking style">
            <button
              class="chip ${snackAppetite === "grazer" ? "on" : ""}"
              onClick=${() => setSnackAppetite("grazer")}
            >
              grazer
            </button>
            <button
              class="chip ${snackAppetite === "meals" ? "on" : ""}"
              onClick=${() => setSnackAppetite("meals")}
            >
              three squares
            </button>
          </div>

          <h2 class="block-title">meals out per week</h2>
          <div class="chips" role="group" aria-label="Typical restaurant or free meals per week">
            ${[
              { label: "rarely", v: 0 },
              { label: "1-2", v: 2 },
              { label: "3-5", v: 4 },
              { label: "most days", v: 7 },
            ].map(
              (o) => html`
                <button
                  class="chip ${mealsOut === o.v ? "on" : ""}"
                  key=${o.label}
                  onClick=${() => setMealsOut(o.v)}
                >
                  ${o.label}
                </button>
              `,
            )}
          </div>
          <p class="hint">
            restaurant, dining hall, free work lunches: the planner's 🍴 OUT slots and the assistant
            use this to expect them.
          </p>

          <h2 class="block-title">weeknight time</h2>
          <div class="chips" role="group" aria-label="Weeknight time budget">
            ${[
              { label: "15 min", v: 15 },
              { label: "30 min", v: 30 },
              { label: "45+ min", v: null },
            ].map(
              (o) => html`
                <button
                  class="chip ${maxWeeknightMinutes === o.v ? "on" : ""}"
                  key=${o.label}
                  onClick=${() => setMaxWeeknightMinutes(o.v)}
                >
                  ${o.label}
                </button>
              `,
            )}
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

          <details class="survey-optional">
            <summary class="block-title">make it yours (optional)</summary>

            <h2 class="block-title">eaten too much of lately</h2>
            <input
              aria-label="Foods eaten too much of lately, comma separated"
              placeholder="in a rut? e.g. pasta, stir-fry, chicken"
              value=${tiredOf}
              onInput=${(/** @type {any} */ e) => setTiredOf(e.currentTarget.value)}
            />
            <p class="hint">
              these lose ties softly, so the week drifts toward variety without banning them.
            </p>

            <h2 class="block-title">leftovers</h2>
            <div class="chips" role="group" aria-label="Leftover tolerance">
              ${[
                { label: "avoid them", v: "none" },
                { label: "some are fine", v: "some" },
                { label: "love batch-cooking", v: "lots" },
              ].map(
                (o) => html`
                  <button
                    class="chip ${leftoverTolerance === o.v ? "on" : ""}"
                    key=${o.v}
                    onClick=${() => setLeftoverTolerance(/** @type {any} */ (o.v))}
                  >
                    ${o.label}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">lunch</h2>
            <div class="chips wrapchips" role="group" aria-label="Lunch situation">
              <button
                class="chip ${packsLunch ? "on" : ""}"
                aria-pressed=${packsLunch}
                onClick=${() => setPacksLunch(!packsLunch)}
              >
                pack it for work/school
              </button>
              ${
                packsLunch &&
                html`<button
                  class="chip ${lunchMicrowave ? "on" : ""}"
                  aria-pressed=${lunchMicrowave}
                  onClick=${() => setLunchMicrowave(!lunchMicrowave)}
                >
                  microwave there
                </button>`
              }
            </div>
            ${
              packsLunch &&
              !lunchMicrowave &&
              html`<p class="hint">no microwave = lunches favor cold-packable meals.</p>`
            }

            <h2 class="block-title">foods to skip</h2>
            <input
              aria-label="Dislikes, comma separated"
              placeholder="dislikes, comma separated"
              value=${dislikes}
              onInput=${(/** @type {any} */ e) => setDislikes(e.currentTarget.value)}
            />
            <p class="hint">softer than an allergy — these lose ties, never vanish entirely.</p>

            <h2 class="block-title">cuisines (tap = love, tap again = avoid)</h2>
            <div class="chips wrapchips" role="group" aria-label="Cuisine preferences">
              ${CUISINES.map(
                (c) => html`
                  <button
                    class="chip ${
                      cuisinePrefs[c] === "loved"
                        ? "on"
                        : cuisinePrefs[c] === "avoided"
                          ? "off"
                          : ""
                    }"
                    key=${c}
                    onClick=${() => cycleCuisine(c)}
                  >
                    ${cuisinePrefs[c] === "loved" ? "♥ " : cuisinePrefs[c] === "avoided" ? "✕ " : ""}${c}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">cooking skill</h2>
            <div class="chips" role="group" aria-label="Cooking skill">
              ${[
                { label: "beginner", v: 1 },
                { label: "comfortable", v: 2 },
                { label: "confident", v: 3 },
              ].map(
                (o) => html`
                  <button
                    class="chip ${maxDifficulty === o.v ? "on" : ""}"
                    key=${o.label}
                    onClick=${() => setMaxDifficulty(/** @type {any} */ (o.v))}
                  >
                    ${o.label}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">kitchen gear (tap what they have)</h2>
            <div class="chips wrapchips" role="group" aria-label="Kitchen equipment">
              ${EQUIPMENT.map(
                (eq) => html`
                  <button
                    class="chip ${equipment.includes(eq) ? "on" : ""}"
                    key=${eq}
                    aria-pressed=${equipment.includes(eq)}
                    onClick=${() => setEquipment(toggleIn(equipment, eq))}
                  >
                    ${eq}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">breakfast style</h2>
            <div class="chips wrapchips" role="group" aria-label="Breakfast style">
              ${["sweet", "savory", "grab-and-go", "surprise"].map(
                (s) => html`
                  <button
                    class="chip ${breakfastStyle === s ? "on" : ""}"
                    key=${s}
                    onClick=${() => setBreakfastStyle(/** @type {any} */ (s))}
                  >
                    ${s}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">budget</h2>
            <div class="chips" role="group" aria-label="Budget sensitivity">
              ${[
                { label: "tight", v: "tight" },
                { label: "normal", v: "normal" },
                { label: "not fussy", v: "loose" },
              ].map(
                (o) => html`
                  <button
                    class="chip ${budget === o.v ? "on" : ""}"
                    key=${o.v}
                    onClick=${() => setBudget(/** @type {any} */ (o.v))}
                  >
                    ${o.label}
                  </button>
                `,
              )}
            </div>

            <h2 class="block-title">stores they shop</h2>
            <input
              aria-label="Stores, comma separated"
              placeholder="stores, e.g. Mariano's, Aldi"
              value=${stores}
              onInput=${(/** @type {any} */ e) => setStores(e.currentTarget.value)}
            />

            <h2 class="block-title">shopping trips a week</h2>
            <div class="chips" role="group" aria-label="Shopping trips per week">
              ${[1, 2, 3].map(
                (n) => html`
                  <button
                    class="chip ${shopsPerWeek === n ? "on" : ""}"
                    key=${n}
                    onClick=${() => setShopsPerWeek(n)}
                  >
                    ${n}${n > 1 ? " trips" : " trip"}
                  </button>
                `,
              )}
            </div>
            <p class="hint">2+ splits the list into a pantry run and a fresh run.</p>
          </details>

          <div class="actions">
            <button class="primary" onClick=${addProfile} disabled=${!formValid || saving}>
              ${saving ? "SETTING UP…" : "ADD & OPEN"}
            </button>
          </div>
          ${saveErr && html`<p class="hint">⚠ ${saveErr}</p>`}
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
