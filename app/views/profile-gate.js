import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { readProfiles, patchProfiles, writeTargetsOf } from "../lib/store.js";
import { getToken } from "../lib/github.js";
import {
  targetsFromQuestionnaire,
  avoidTermsFromAllergens,
  outsideSafeBand,
} from "../lib/targets.js";
/** @typedef {import("../lib/targets.js").mergeProfileAnswers} MergeFn */
import { localIsoDate } from "../lib/dates.js";
import { OnboardView } from "./onboard.js";
import {
  ADMIN_DEVICE_KEY,
  DEVICE_HOUSE_KEY,
  boundaryOn,
  chooserProfiles,
  isAdmin,
  maySwitchTo,
  profilesNamed,
  allowedNewHouse,
  cleanPasskey,
  verifiedKey,
  keyOf,
  validPasskey,
} from "../lib/privacy.js";

/** @param {string} key */
const stored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

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
/** Allergen preset ids — must match ALLERGEN_TERMS keys in app/lib/targets.js. */
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

/**
 * @param {{ guest?: boolean, onDone?: (id: string) => void, invite?: { code: string, house: string }, busy?: boolean, onInviteSubmit?: (entry: Record<string, any>, targets: Record<string, any>) => Promise<void>, lead?: any, extraValid?: boolean, onExtraInvalid?: () => void, edit?: { id: string, targets: Record<string, any>, onSave: (fresh: Record<string, any>, stated: Parameters<MergeFn>[2]) => Promise<boolean> } }} [props] guest
 * mode (guesthouse spec §8, David's yes 2026-08-29 plenum): the SAME
 * questionnaire, but the profile lands in the `guesthouse` household, the
 * device stays signed in as its owner, and onDone fires instead of a
 * profile switch. A guesthouse profile is never a sign-in identity (§5),
 * so the picker below also refuses to offer one.
 */
export function ProfileGateView({
  guest = false,
  onDone = undefined,
  invite = undefined,
  busy = false,
  onInviteSubmit = undefined,
  lead = null,
  // the caller's own fields must be valid too (v1.6: the guest's login)
  extraValid = true,
  onExtraInvalid = undefined,
  edit = undefined,
} = {}) {
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
  const [goalWeightLb, setGoalWeightLb] = useState("");
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
  // household = who you shop with right now (movable in Settings)
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
    // an invitee's phone has no token: do not even ask for the list; an
    // edit inside Settings does not need it either
    if (invite || edit) {
      setLoading(false);
      return;
    }
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

  // THE ADMIN ROW NEEDS ITS PASSKEY (Tribunal plan gate, 2026-10-18: on a
  // roommate's phone, tapping the admin's name would have shown the family)
  const [askPin, setAskPin] = useState(/** @type {string | null} */ (null));
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [typedName, setTypedName] = useState("");
  const adminDevice = stored(ADMIN_DEVICE_KEY) === "1";
  // a new profile joins this device's own house unless this is the admin's
  // device (Tribunal Red Team: "+ add profile" could be typed into the family)
  const mayPlaceAnywhere = !boundaryOn(profiles) || adminDevice;
  const houseForNew = () =>
    allowedNewHouse(profiles, stored(DEVICE_HOUSE_KEY), adminDevice, household);
  const signIn = (/** @type {string} */ id, verified = true) => {
    localStorage.setItem("mise.activeProfile", id);
    try {
      if (verified) localStorage.setItem(verifiedKey(id), "1");
      else localStorage.removeItem(verifiedKey(id));
    } catch {
      // storage refused: the profile simply asks again next time
    }
    location.reload();
  };
  const choose = async (/** @type {string} */ id, /** @type {string} */ withPin = "") => {
    if (guest) {
      // never sign in as a guest: hand the phone back and land on Tables
      onDone?.(id);
      return;
    }
    const target = profiles.find((p) => p.id === id);
    const deviceHouse = stored(DEVICE_HOUSE_KEY);
    const crossHouse =
      boundaryOn(profiles) &&
      !adminDevice &&
      deviceHouse !== null &&
      !isAdmin(target) &&
      String(target?.household ?? "home") !== deviceHouse;
    if ((keyOf(target) || crossHouse) && !withPin) {
      setAskPin(id);
      setPin("");
      setPinErr(crossHouse ? "another household's profile: the admin's passkey opens it" : "");
      return;
    }
    if (!(await maySwitchTo(target, withPin, adminDevice, { profiles, deviceHouse }))) {
      // a miss wipes the box (David, 2026-10-18: old digits stayed, so every
      // retry was the old digits plus the right passkey and never matched)
      setPin("");
      setPinErr(
        keyOf(target) || crossHouse
          ? "that passkey doesn't match"
          : "this profile can only be opened on its own phone",
      );
      return;
    }
    // a sign-in from the built-in default list (offline, empty cache) never
    // verifies the profile on this phone (Tribunal Red Team, loop 1)
    signIn(id, !fallback);
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

  // YOUR PROFILE, EDITED (v1.8, P3): the survey pre-filled from the file
  // in edit mode a person with no body numbers on file starts with no sex
  // picked (Tribunal Realist: the "f" default would save a female body)
  const [sexPicked, setSexPicked] = useState(!edit);
  const [statedCal, setStatedCal] = useState("");
  const [statedPro, setStatedPro] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [editNote, setEditNote] = useState("");
  useEffect(() => {
    if (!edit) return;
    const t = edit.targets ?? {};
    const b = t.body ?? {};
    if (b.sex === "m" || b.sex === "f") {
      setSex(b.sex);
      setSexPicked(true);
    }
    if (b.age) setAge(String(b.age));
    if (b.heightIn) {
      setHeightFt(String(Math.floor(Number(b.heightIn) / 12)));
      setHeightIn(String(Math.round(Number(b.heightIn) % 12)));
    }
    if (b.weightLb) setWeightLb(String(b.weightLb));
    if (b.activity) setActivity(Number(b.activity));
    setGoal(t.phase === "loss" ? "loss" : t.phase === "gain" ? "gain" : "maintain");
    if (t.goalWeightLb ?? b.goalWeightLb) setGoalWeightLb(String(t.goalWeightLb ?? b.goalWeightLb));
    if (t.diet) setDiet(t.diet);
    const algs = Array.isArray(t.allergens) ? t.allergens : [];
    setAllergens(algs);
    // avoid terms the allergens do not already imply ride in the free text,
    // so a re-save keeps them (Elliot's "tempeh, pesto")
    const implied = new Set(avoidTermsFromAllergens(algs, ""));
    setAllergensFreeText(
      (Array.isArray(t.avoidIngredients) ? t.avoidIngredients : [])
        .filter((/** @type {string} */ a) => !implied.has(a))
        .join(", "),
    );
    if (t.snackAppetite) setSnackAppetite(t.snackAppetite);
    if (t.maxWeeknightMinutes) setMaxWeeknightMinutes(t.maxWeeknightMinutes);
    setDislikes((t.dislikeIngredients ?? []).join(", "));
    /** @type {Record<string, "loved" | "avoided">} */
    const cp = {};
    for (const c of t.cuisinePrefs?.loved ?? []) cp[c] = "loved";
    for (const c of t.cuisinePrefs?.avoided ?? []) cp[c] = "avoided";
    setCuisinePrefs(cp);
    if (t.maxDifficulty) setMaxDifficulty(t.maxDifficulty);
    if (Array.isArray(t.equipment)) setEquipment(t.equipment);
    if (t.breakfastStyle) setBreakfastStyle(t.breakfastStyle);
    if (t.budget === "tight" || t.budget === "loose") setBudget(t.budget);
    setStores((t.stores ?? []).join(", "));
    if (t.shopsPerWeek) setShopsPerWeek(t.shopsPerWeek);
    setTiredOf((t.tiredOf ?? []).join(", "));
    if (t.region?.state) setUsState(String(t.region.state));
    if (t.leftoverTolerance) setLeftoverTolerance(t.leftoverTolerance);
    setPacksLunch(Boolean(t.packsLunch));
    setLunchMicrowave(Boolean(t.lunchMicrowave));
    setMealsOut(Number(t.mealsOutPerWeek) || 0);
    setStatedCal(String(t.macros?.calories ?? ""));
    setStatedPro(String(t.macros?.protein ?? ""));
    setGoalDate(String(t.base?.goal?.date ?? ""));
    setName(edit.id);
    setEmoji("·");
  }, []);

  // the survey answers as a targets file (shared by ADD and the v1.8 edit)
  const freshTargets = () => {
    const loved = Object.keys(cuisinePrefs).filter((c) => cuisinePrefs[c] === "loved");
    const avoided = Object.keys(cuisinePrefs).filter((c) => cuisinePrefs[c] === "avoided");
    const equipAll = EQUIPMENT.every((e) => equipment.includes(e));
    return targetsFromQuestionnaire(
      {
        sex,
        age: numeric.age,
        heightFt: numeric.heightFt,
        heightIn: numeric.heightIn,
        weightLb: numeric.weightLb,
        ...(goal === "loss" && Number(goalWeightLb) > 0
          ? { goalWeightLb: Number(goalWeightLb) }
          : {}),
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
  };

  // body numbers are optional in edit mode: without them nothing about the
  // body is saved and there is no suggestion, but every other answer saves
  const bodyGiven = formValid && sexPicked;
  const recommended = (() => {
    try {
      return bodyGiven ? Math.round(Number(freshTargets().macros.calories)) : 0;
    } catch {
      return 0;
    }
  })();
  const calNum = Number(statedCal);
  const needsReason = outsideSafeBand(calNum, recommended);
  const saveEdit = async () => {
    if (!edit || saving) return;
    if (!(calNum >= 1000 && calNum <= 12000) || !(Number(statedPro) >= 30)) {
      setEditNote("set a calorie target (1,000 to 12,000) and a protein target");
      return;
    }
    if (needsReason && !overrideReason.trim()) {
      setEditNote("that target is far from what your numbers suggest: say why below, then save");
      return;
    }
    setSaving(true);
    setEditNote("");
    // the merge itself runs against the file as it is at SAVE (main.js), so
    // a budget or meal change saved meanwhile is not lost
    const stated = {
      calories: calNum,
      protein: Number(statedPro),
      reason: needsReason ? overrideReason : "",
      todayIso: localIsoDate(new Date()),
      ...(bodyGiven
        ? {
            body: {
              sex,
              age: numeric.age,
              heightIn: numeric.heightFt * 12 + numeric.heightIn,
              weightLb: numeric.weightLb,
              activity,
              ...(Number(goalWeightLb) > 0 ? { goalWeightLb: Number(goalWeightLb) } : {}),
            },
          }
        : {}),
      ...(goalDate ? { goalDate } : {}),
    };
    const ok = await edit.onSave(freshTargets(), stated);
    setSaving(false);
    setEditNote(
      ok ? "saved: the next SET MY WEEK plans from this" : "could not save; nothing changed",
    );
  };

  const addProfile = async () => {
    // the login boxes live at the top of a long form: a tap with them empty
    // says so up there instead of a grey button that never explains itself
    // (audit 2026-10-18)
    if (formValid && !saving && !busy && !extraValid) {
      onExtraInvalid?.();
      return;
    }
    if (!formValid || saving || busy || !extraValid) return;
    const trimmedName = name.trim();
    const id = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    // JOIN BY LINK: the Worker picks a free id and writes the files; this
    // device has no token and no profile list to collide against
    if (!id || (!invite && profiles.some((p) => p.id === id))) return;
    setSaving(true);
    setSaveErr("");
    const targets = freshTargets();
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
      // INVERTED DEFAULT (council 2026-08-02): a new profile starts at the
      // family minimum — plan, list, dinners, settings. Extra surfaces
      // (check-in, scoreboard, money) get hand-added to capabilities when
      // that person actually wants them; features argue their way IN.
      capabilities: /** @type {string[]} */ ([]),
      // "home" (or blank) is the default: store as absent, not a string.
      // A guest lands in the guesthouse, always: an explicit slug that
      // belongs to nobody (the spec's correction 1 — no household at all
      // would silently mean "home", a real kitchen with real shelves)
      ...(guest
        ? { household: "guesthouse" }
        : houseForNew().trim() && houseForNew().trim().toLowerCase() !== "home"
          ? { household: slugify(houseForNew()) }
          : {}),
      ...(family.trim() && mayPlaceAnywhere ? { family: slugify(family) } : {}),
    };
    if (invite && onInviteSubmit) {
      setSaving(false);
      await onInviteSubmit(
        {
          name: trimmedName,
          emoji: emoji.trim(),
          ...(family.trim() ? { family: slugify(family) } : {}),
        },
        targets,
      );
      return;
    }
    // await the cache writes (not the network flush, which queues and
    // survives fine) so the reload below never races the local records.
    // Both paths are raw: the gate runs BEFORE a profile is chosen, so
    // scoping must not apply. profiles.json is never scoped anyway.
    await writeTargetsOf(id, targets);
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
    ...(houseForNew().trim() ? { household: houseForNew().trim() } : {}),
    ...(usState.trim() ? { state: usState.trim().toUpperCase() } : {}),
    ...(age ? { age: Number(age) } : {}),
    ...(heightFt ? { heightFt: Number(heightFt) } : {}),
    ...(weightLb ? { weightLb: Number(weightLb) } : {}),
    ...(goalWeightLb ? { goalWeightLb: Number(goalWeightLb) } : {}),
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

  const form = html`
      <details open=${guest || Boolean(invite) || Boolean(edit)}>
      <summary class="block-title">
        ${guest || invite || edit ? "your profile" : "+ add profile"}
      </summary>
        <div class="tile">
          <p class="hint">
            ${
              edit
                ? "Change anything and SAVE. Only what this survey asks about changes; everything else in your profile stays as it is."
                : guest || invite
                ? "Your name, your numbers, and anything you can't or won't eat. The more you fill in, the better your plate fits."
                : 'fill what you like here, or tap "set up by conversation" above and answer a few questions.'
            }
          </p>
          <div class="token-form" hidden=${Boolean(edit)}>
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
          <div class="token-form" hidden=${guest || Boolean(invite) || Boolean(edit)}>
            <input
              hidden=${!mayPlaceAnywhere}
              aria-label="Family this person belongs to"
              placeholder="family"
              value=${family}
              onInput=${(/** @type {any} */ e) => setFamily(e.currentTarget.value)}
            />
            <input
              hidden=${!mayPlaceAnywhere}
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
          <p class="hint" hidden=${guest || Boolean(invite) || Boolean(edit)}>
            family is who they ARE (the chooser groups by it); a house is the kitchen they cook and
            shop with right now, movable any time in Settings. State sets the List's grocery tax.
          </p>

          <h2 class="block-title">${guest || invite ? "about you" : "about them"}</h2>
          <div class="chips" role="group" aria-label="Sex (for calorie math)">
          <button
            class="chip ${sexPicked && sex === "f" ? "on" : ""}"
            onClick=${() => {
                setSex("f");
                setSexPicked(true);
            }}
          >
              female
            </button>
          <button
            class="chip ${sexPicked && sex === "m" ? "on" : ""}"
            onClick=${() => {
                setSex("m");
                setSexPicked(true);
            }}
          >
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
          ${
            goal === "loss" &&
            html`
              <div class="row">
                <input
                  aria-label="Goal weight in pounds"
                  placeholder="goal lb"
                  inputmode="numeric"
                  value=${goalWeightLb}
                  onInput=${num(setGoalWeightLb)}
                />
              </div>
              <p class="hint">
                Optional, and it changes one thing: the protein floor anchors to the weight you are
                heading for instead of the one you are carrying. Protein is there to protect muscle
                while the fat comes off, and muscle does not scale with the fat. Calories still come
                from your weight today.
              </p>
            `
          }

          <h2 class="block-title">${guest || invite ? "what you eat" : "what they eat"}</h2>
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

          <h2 class="block-title" hidden=${Boolean(edit)}>meals a day</h2>
        <div
          class="chips wrapchips"
          role="group"
          aria-label="Meals per day"
          hidden=${Boolean(edit)}
        >
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
            <div class="chips wrapchips" role="group" aria-label="Leftover tolerance">
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

          ${
            edit &&
            html`<h2 class="block-title">your daily target</h2>
              <div class="token-form">
                <input
                  aria-label="Calories a day"
                  inputmode="numeric"
                  value=${statedCal}
                  onInput=${(/** @type {any} */ e) => setStatedCal(e.currentTarget.value)}
                />
                <input
                  aria-label="Protein grams a day"
                  inputmode="numeric"
                  value=${statedPro}
                  onInput=${(/** @type {any} */ e) => setStatedPro(e.currentTarget.value)}
                />
              </div>
              ${
                !bodyGiven &&
                html`<p class="hint">
                  Add your sex, age, height and weight above to save them and get Mise's suggestion;
                  everything else saves without them.
                </p>`
              }
              <p class="hint">
                calories and protein grams a day.
                ${recommended > 0 ? ` From your numbers Mise suggests about ${recommended.toLocaleString()} kcal.` : ""}
              </p>
              ${
                needsReason &&
                html`<p class="hint scanerr" role="alert">
                    ⚠ ${calNum.toLocaleString()} kcal is far from the
                    ${recommended.toLocaleString()} your numbers suggest. That can be right (a
                    doctor's plan, a sport, a set protocol); say which.
                  </p>
                  <input
                    aria-label="Why this target"
                    placeholder="why this target"
                    value=${overrideReason}
                    onInput=${(/** @type {any} */ e) => setOverrideReason(e.currentTarget.value)}
                  />`
              }
              <div class="token-form">
                <input
                  aria-label="Goal date"
                  type="date"
                  value=${goalDate}
                  onInput=${(/** @type {any} */ e) => setGoalDate(e.currentTarget.value)}
                />
              </div>
              <p class="hint">the date you want to reach your goal by (optional)</p>`
          }
          <div class="actions">
            <button
              class="primary"
              onClick=${edit ? saveEdit : addProfile}
              disabled=${edit ? saving : !formValid || saving}
            >
              ${edit ? (saving ? "SAVING…" : "SAVE MY PROFILE") : saving ? "SETTING UP…" : "ADD & OPEN"}
            </button>
          </div>
          ${editNote && html`<p class="hint" role="status">${editNote}</p>`}
          ${saveErr && html`<p class="hint">⚠ ${saveErr}</p>`}
        ${
            !edit &&
            html`<p class="hint">
            ADD lights up when everything is filled in: name, emoji, age 10-100, height 3-7 ft
            (inches 0-11), weight 60-500 lb.
            </p>`
          }
          <p class="hint">
          ${guest || invite
            ? "Calories and protein are worked out from your answers, and every plate is checked against your allergies."
            : "calories and protein are computed from these answers (Mifflin-St Jeor); recipes come from the shared bank matched to the goal. Everything is adjustable later in Settings."}
          </p>
        </div>
      </details>
  `;
  // EDIT MODE (v1.8): the same fuller survey, pre-filled, inside Settings
  if (edit) return form;
  return html`
    <div class="view">
      <div class="hero">
        <h1>Mise<span>.</span></h1>
        <div class="sub">
          ${
            invite
            ? invite.house === "guesthouse"
              ? "Welcome to Mise. This is a guest link: make your profile once, here on your own phone, and every plate is sized for you and checked against your allergies."
              : "You've been invited to join a shared kitchen. Fill this in once, on your own phone."
            : guest
              ? "guest profile — fill this in and the table sets your plate to your own numbers"
                : "who's checking in?"
          }
        </div>
      </div>
      ${lead} ${loading && html`<p class="hint">loading profiles…</p>`}
      ${
        fallback &&
        !loading &&
        !invite &&
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
          // §5: a guesthouse profile is never a sign-in identity — Sam must
          // not see Priya, so nobody is ever "inside" the guesthouse. And
          // only this device's own household (privacy.js, 2026-10-18): a
          // fresh device lists no one and asks for a name below.
          const offerable = chooserProfiles(profiles, stored(DEVICE_HOUSE_KEY), adminDevice);
          const fams = [...new Set(offerable.map(famOf))];
          // family headings are the admin's view: on a roommate's phone the
          // heading named the admin's family (Tribunal Realist, 2026-10-18)
          const showHeaders =
            (!boundaryOn(profiles) || adminDevice) &&
            fams.filter(Boolean).length > 0 &&
            fams.length > 1;
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
          if (guest || invite) return "";
          if (!showHeaders) return block(offerable);
          return fams
            .sort((a, b) => (a || "zz").localeCompare(b || "zz"))
            .map(
              (f) => html`
                <div key=${f || "none"}>
                  <h2 class="block-title">${f ? f.toUpperCase() : "EVERYONE ELSE"}</h2>
                  ${block(offerable.filter((p) => famOf(p) === f))}
                </div>
              `,
            );
        })()
      }
      ${
        askPin &&
        // digits shown, not dots (David, 2026-10-18: "This isn't something
        // people are looking over your shoulder for. You can show the
        // numbers"); the box gets the full width, OPEN sits under it
        html`<form
          class="tile pin-form"
          onSubmit=${(/** @type {any} */ e) => {
            e.preventDefault();
            choose(/** @type {string} */ (askPin), pin);
          }}
        >
          <label class="k" for="open-passkey">
            Passkey for ${profiles.find((p) => p.id === askPin)?.name ?? "this profile"}
          </label>
            <input
            id="open-passkey"
            class="pin-input"
            type="text"
              inputmode="numeric"
            pattern="[0-9]*"
              autocomplete="off"
            maxlength="8"
            placeholder="4 to 8 digits"
              value=${pin}
            onInput=${(/** @type {any} */ e) => setPin(cleanPasskey(e.currentTarget.value))}
            />
          <button class="ask" type="submit" disabled=${!validPasskey(pin)}>OPEN</button>
        </form>`
      }
      ${
        // a fresh device only (Tribunal Red Team): on a device that already
        // belongs to a household, a typed name could reach another one
        !guest &&
        !invite &&
        boundaryOn(profiles) &&
        stored(DEVICE_HOUSE_KEY) === null &&
        html`<div class="tile">
          <div class="k">Not listed? Type your name</div>
          <div class="token-form">
            <input
              aria-label="Your name"
              value=${typedName}
              onInput=${(/** @type {any} */ e) => setTypedName(e.currentTarget.value)}
            />
            <button
              class="secondary"
              onClick=${() => {
                const found = profilesNamed(profiles, typedName);
                if (found.length !== 1) {
                  setPinErr("no profile by that name on this kitchen's list");
                  return;
                }
                void choose(/** @type {string} */ (found[0]?.id));
              }}
            >
              OPEN
            </button>
          </div>
        </div>`
      }
      ${pinErr && html`<p class="hint scanerr" role="status">${pinErr}</p>`}
      <button
        class="secondary linkbtn"
        hidden=${guest || Boolean(invite)}
        onClick=${() => setChatMode(true)}
      >
        prefer to chat? set up by conversation →
      </button>
      ${form}
    </div>
  `;
}
