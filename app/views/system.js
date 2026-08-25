import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import {
  DATA_REPO,
  tokenAgeDays,
  TOKEN_WARN_AGE_DAYS,
  setDataRepo,
  dataRepoOverridden,
} from "../lib/github.js";
import { formatSyncTime } from "../lib/dates.js";
import { activeProfile, readProfiles, patchProfiles, read, write } from "../lib/store.js";
import {
  canAssignRoles,
  householdPathFor,
  normalizeHousehold,
  setMemberRoles,
} from "../lib/household.js";
import { TOUR_STEPS, TOUR_TABS } from "../lib/tour.js";
import { EQUIPMENT, canMake, unlockCounts } from "../lib/equipment.js";
import { notifyTest } from "../lib/worker.js";

/**
 * System status view: app health, sync queue, data-repo checks, token entry.
 * All state lives in the app shell; this view just renders and forwards events.
 * @param {{
 *   sw: "installing" | "ready" | "failed",
 *   sync: Record<string, any>,
 *   repo: Record<string, any> | null,
 *   hasToken: boolean,
 *   draft: string,
 *   onDraft: (v: string) => void,
 *   onSaveToken: () => void,
 *   onTestWrite: () => void,
 *   onExport: () => void,
 *   onReplayTour: () => void,
 *   tourState: import("../lib/tour.js").TourState | null,
 *   targets?: Record<string, any> | null,
 *   bankRecipes?: Record<string, any>[],
 *   onSaveEquipment?: (owned: string[]) => Promise<void>
 * }} props
 */
export function SystemView({
  sw,
  sync,
  repo,
  hasToken,
  draft,
  onDraft,
  onSaveToken,
  onTestWrite,
  onExport,
  onReplayTour,
  tourState,
  targets,
  bankRecipes,
  onSaveEquipment,
}) {
  const ageDays = tokenAgeDays();
  const renewSoon = hasToken && ageDays != null && ageDays >= TOKEN_WARN_AGE_DAYS;

  // ---- WHAT IS IN YOUR KITCHEN (P6/P7) -----------------------------------
  // Until 2026-08-22 this could only be changed by editing a JSON file, which
  // meant the app could not actually be run by the person using it. Two
  // directions, and both are the point: a kitchen that cannot do something is
  // not offered it, and adding a thing EXPANDS what you are offered, with the
  // count shown so "is a Dutch oven worth it" has a number instead of a guess.
  const declared = Array.isArray(targets?.equipment) ? targets.equipment : null;
  const [gearDraft, setGearDraft] = useState(/** @type {string[] | null} */ (null));
  const [gearBusy, setGearBusy] = useState(false);
  const [gearNote, setGearNote] = useState("");
  const gear = gearDraft ?? declared ?? [];
  // UNDECLARED IS NOT EMPTY, and the readout has to say so. Showing the
  // empty-kitchen count to someone who has declared nothing reads as "you can
  // cook 33 things and no dinners", which is both false and alarming: an
  // undeclared kitchen is offered everything. Caught by opening the app.
  const undeclared = gearDraft === null && declared === null;
  const filterWith = undeclared ? null : gear;
  const bank = Array.isArray(bankRecipes) ? bankRecipes : [];
  const cookableNow = bank.filter((r) => canMake(filterWith, r.equipment)).length;
  const dinnersNow = bank.filter(
    (r) => r.mealType === "dinner" && canMake(filterWith, r.equipment),
  ).length;
  const totalDinners = bank.filter((r) => r.mealType === "dinner").length;
  const unlocks = undeclared ? [] : unlockCounts(gear, bank);
  const toggleGear = (/** @type {string} */ id) =>
    setGearDraft(gear.includes(id) ? gear.filter((/** @type {string} */ x) => x !== id) : [...gear, id].sort());
  const saveGear = async () => {
    if (!onSaveEquipment || gearDraft === null) return;
    setGearBusy(true);
    setGearNote("");
    try {
      await onSaveEquipment(gearDraft);
      setGearDraft(null);
      setGearNote("saved");
    } catch (e) {
      setGearNote(e instanceof Error ? e.message : "could not save");
    } finally {
      setGearBusy(false);
    }
  };

  // notification pipeline test (ntfy ping + today's would-fire schedule)
  const [notify, setNotify] = useState(/** @type {null | "busy" | "done"} */ (null));
  const [notifyErr, setNotifyErr] = useState("");
  const [notifyResult, setNotifyResult] = useState(
    /** @type {null | { pinged: boolean, topicSet: boolean, cronReady: boolean, preview: { title: string, body: string }[] }} */ (
      null
    ),
  );
  const runNotifyTest = async () => {
    if (notify === "busy") return;
    setNotify("busy");
    setNotifyErr("");
    setNotifyResult(null); // a failed retest must not leave a stale success tile
    try {
      setNotifyResult(await notifyTest());
    } catch (err) {
      setNotifyErr(err instanceof Error ? err.message : "test failed — needs signal + token");
    }
    setNotify("done");
  };

  // full list for DISPLAY; every write goes through patchProfiles (G2), which
  // mutates the real file by id and refuses when it can't be loaded — a
  // stale/fallback list here can no longer erase other profiles.
  const [allProfiles, setAllProfiles] = useState(
    /** @type {Record<string, any>[] | null} */ (null),
  );
  const [profilesFallback, setProfilesFallback] = useState(false);
  const [profileErr, setProfileErr] = useState("");
  useEffect(() => {
    let alive = true;
    readProfiles().then((p) => {
      if (!alive) return;
      setAllProfiles(p.profiles);
      setProfilesFallback(Boolean(/** @type {any} */ (p).fallback));
    });
    return () => {
      alive = false;
    };
  }, []);
  const me = activeProfile();
  const profile = allProfiles
    ? (allProfiles.find((x) => x.id === me) ?? { id: me, name: me, emoji: "" })
    : null;

  // apply an id-targeted patch through the safe path; mirrors into local
  // state for instant UI, surfaces the refusal case honestly
  const applyPatch = async (
    /** @type {(x: Record<string, any>) => Record<string, any>} */ patch,
  ) => {
    const fallbackEntry = { id: me, name: profile?.name ?? me, emoji: profile?.emoji ?? "" };
    const ok = await patchProfiles((list) =>
      list.some((x) => x.id === me)
        ? list.map((x) => (x.id === me ? patch(x) : x))
        : [...list, patch(fallbackEntry)],
    );
    if (!ok) {
      setProfileErr(
        "couldn't load the real profile list (offline or token not set), nothing was changed, so other profiles stay safe. Try again once synced.",
      );
      return false;
    }
    setProfileErr("");
    setAllProfiles((cur) => (cur ? cur.map((x) => (x.id === me ? patch(x) : x)) : cur));
    return true;
  };

  // household (profiles.json household, absent = "home"): which grocery trip
  // this profile's list merges into. Editable so a member can move for a week
  // (Laurie visiting joins "home", then moves back to hers).
  const [householdDraft, setHouseholdDraft] = useState(/** @type {string | null} */ (null));
  const household = /** @type {string} */ (profile?.household ?? "home");
  const householdShown = householdDraft ?? household;
  const saveHousehold = () => {
    const clean = householdShown
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    void applyPatch((x) => {
      const rest = { ...x };
      // "home" (or blank) is the default: store as absent, not as a string
      delete rest.household;
      return clean && clean !== "home" ? { ...rest, household: clean } : rest;
    }).then((ok) => {
      if (ok) setHouseholdDraft(null);
    });
  };

  // ---- HOUSEHOLD MANAGEMENT (P6, spec 2026-08-25) ------------------------
  // "Do this from the app": creating a house was already MOVE HOUSE above,
  // but renaming one for EVERYONE and adding a housemate could only be done
  // by editing JSON, which meant David could not do it. Standing rule: ship
  // the button, never fix the data backstage.
  const housemates = (allProfiles ?? []).filter(
    (x) => (x.household ?? "home") === household,
  );
  const outsiders = (allProfiles ?? []).filter(
    (x) => (x.household ?? "home") !== household,
  );
  const [houseDoc, setHouseDoc] = useState(/** @type {Record<string, any> | null} */ (null));
  useEffect(() => {
    let alive = true;
    void read(householdPathFor(household), { raw: true }).then((h) => {
      if (alive) setHouseDoc(/** @type {any} */ (h));
    });
    return () => {
      alive = false;
    };
  }, [household]);
  const [houseBusy, setHouseBusy] = useState(false);
  const [houseNote, setHouseNote] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [addPick, setAddPick] = useState("");
  const slugify = (/** @type {string} */ s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Rename the house for EVERYONE in it: carry the shared files to the new
  // slug, then re-point every member profile. The old files are left in
  // place (a copy, not a destructive move) — pantryPathFor derives from
  // profiles.json, so once the profiles move nothing reads them again.
  // Reviewer findings 2-4 (2026-08-25) shaped three guards below: the
  // cache-only read means "null" can be "not synced to this device" as well
  // as "does not exist", so misses are NAMED rather than swallowed; a
  // rename into an existing slug would field-wise-MERGE two households'
  // pantries and depose the target's head, so it is refused (with "home",
  // every unmoved profile's default, refused outright); and the members to
  // move are selected inside patchProfiles against the real list, never
  // from this device's possibly-stale snapshot.
  const HOUSE_FILES = ["household.json", "pantry.json", "waste.json", "events.json", "ledger.json"];
  const renameHouse = async () => {
    const to = slugify(renameDraft);
    if (!to || to === household || houseBusy) return;
    if (to === "home") {
      setHouseNote(`"home" is the shared default house — renaming into it would mix this house's pantry and ledger into everyone else's`);
      return;
    }
    const hh = normalizeHousehold(houseDoc);
    if (!canAssignRoles(hh, me ?? "")) {
      setHouseNote("only the head of the household renames it");
      return;
    }
    setHouseBusy(true);
    setHouseNote("");
    try {
      const existing = await Promise.all([
        read(householdPathFor(to), { raw: true }),
        read(`households/${to}/pantry.json`, { raw: true }),
      ]);
      if (existing.some(Boolean)) {
        setHouseNote(`a house called "${to}" already exists — pick another name, or move people into it one by one`);
        return;
      }
      /** @type {string[]} */
      const carried = [];
      /** @type {string[]} */
      const missing = [];
      for (const f of HOUSE_FILES) {
        const doc = await read(`households/${household}/${f}`, { raw: true });
        if (doc) {
          await write(`households/${to}/${f}`, doc, { raw: true });
          carried.push(f);
        } else {
          missing.push(f);
        }
      }
      const move = (/** @type {Record<string, any>} */ x) => {
        const rest = { ...x };
        delete rest.household;
        return { ...rest, household: to };
      };
      const ok = await patchProfiles((list) =>
        list.map((x) => ((x.household ?? "home") === household ? move(x) : x)),
      );
      if (!ok) {
        setHouseNote("couldn't load the real profile list — nobody moved (the copied files are harmless)");
        return;
      }
      setAllProfiles((cur) =>
        cur ? cur.map((x) => ((x.household ?? "home") === household ? move(x) : x)) : cur,
      );
      setRenameDraft("");
      setHouseNote(
        `renamed — everyone here now shops from "${to}" (carried ${carried.join(", ") || "nothing"}` +
          (missing.length > 0
            ? `; ${missing.join(", ")} not on this device — if they exist they stayed at "${household}", rename again from a synced device to carry them)`
            : `)`),
      );
    } catch (e) {
      setHouseNote(e instanceof Error ? e.message : "rename failed");
    } finally {
      setHouseBusy(false);
    }
  };

  // Add a housemate: writes them into household.json (head-gated — adding IS
  // assigning roles) and points their profile at this house. New members
  // start as an eater; the head can hand out cook/shopper later.
  // Deliberately NEVER writes a headId it did not read (reviewer finding 5,
  // 2026-08-25): the read is cache-only, so a null here can mean "this
  // device hasn't synced the file yet" — inventing headId = me would depose
  // the real head through the field-wise merge. A house with no written
  // head stays headless until someone assigns roles explicitly, which the
  // lib already allows.
  const addMember = async () => {
    const id = addPick;
    if (!id || houseBusy) return;
    setHouseBusy(true);
    setHouseNote("");
    try {
      const path = householdPathFor(household);
      const raw = /** @type {Record<string, any> | null} */ (await read(path, { raw: true }));
      const hh = normalizeHousehold(raw);
      const res = setMemberRoles(hh, me ?? "", id, ["eater"]);
      if (!res.changed) {
        setHouseNote(res.reason);
        return;
      }
      await write(path, { ...(raw ?? {}), members: res.household.members }, { raw: true });
      const ok = await patchProfiles((list) =>
        list.map((x) => {
          if (x.id !== id) return x;
          const rest = { ...x };
          delete rest.household;
          return household === "home" ? rest : { ...rest, household };
        }),
      );
      if (!ok) {
        setHouseNote("profile list unreachable — they are in household.json but not moved");
        return;
      }
      setAllProfiles((cur) =>
        cur
          ? cur.map((x) => {
              if (x.id !== id) return x;
              const rest = { ...x };
              delete rest.household;
              return household === "home" ? rest : { ...rest, household };
            })
          : cur,
      );
      setHouseDoc({ ...(raw ?? {}), members: res.household.members });
      setAddPick("");
      setHouseNote(`added — they now share this house's pantry and trip`);
    } catch (e) {
      setHouseNote(e instanceof Error ? e.message : "add failed");
    } finally {
      setHouseBusy(false);
    }
  };

  // family (profiles.json family, optional): the top-level grouping the
  // profile gate organizes people under. Family = who you ARE (fixed-ish);
  // household = who you shop with right now (movable). David's structure,
  // 2026-07-21.
  const [familyDraft, setFamilyDraft] = useState(/** @type {string | null} */ (null));
  const family = /** @type {string} */ (profile?.family ?? "");
  const familyShown = familyDraft ?? family;
  const saveFamily = () => {
    const clean = familyShown
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    void applyPatch((x) => {
      const rest = { ...x };
      delete rest.family;
      return clean ? { ...rest, family: clean } : rest;
    }).then((ok) => {
      if (ok) setFamilyDraft(null);
    });
  };

  // switch profile: never sets a new one itself — just clears the key so
  // main.js's boot check renders the gate on reload, same clean pattern as
  // choosing a profile there.
  const switchProfile = () => {
    localStorage.removeItem("mise.activeProfile");
    location.reload();
  };

  // B4 friend groups: point this install at another private data repo.
  // Switching WIPES local state (cache, profile, token) — data from one
  // group must never bleed into another's install.
  const [repoDraft, setRepoDraft] = useState(
    dataRepoOverridden() ? `${DATA_REPO.owner}/${DATA_REPO.repo}` : "",
  );
  const applyDataRepo = () => {
    if (!setDataRepo(repoDraft)) {
      setProfileErr("data repo must look like owner/repo");
      return;
    }
    localStorage.removeItem("mise.activeProfile");
    localStorage.removeItem("mise.pat");
    try {
      indexedDB.deleteDatabase("mise");
    } catch {
      // reload re-opens fresh either way
    }
    location.reload();
  };

  return html`
    <div class="view">
      <div class="hero"><h1>System</h1></div>

      <a class="tile" href="#/cookbook">
        <div class="k">Recipe Library</div>
        <div class="v">→</div>
        <div class="d">purpose-tagged · macro'd</div>
      </a>

      <div class="tile">
        <h2 class="k">App</h2>
        <div class="row">
          <span class="k">Profile</span>
          <span class="status dim">${profile ? `${profile.emoji} ${profile.name}` : "…"}</span>
        </div>
        <div class="row">
          <span class="k">Shell</span>
          <span class="status ok">running ✓</span>
        </div>
        <div class="row">
          <span class="k">Offline cache</span>
          ${
            sw === "ready"
              ? html`<span class="status ok">ready</span>`
              : sw === "failed"
                ? html`<span class="status bad">unavailable ✗</span>`
                : html`<span class="status dim">installing…</span>`
          }
        </div>
        <div class="actions">
          <button class="secondary" onClick=${switchProfile}>SWITCH PROFILE</button>
        </div>
        <div class="row">
          <span class="k">House</span>
          <input
            aria-label="House this profile cooks and shops from"
            value=${householdShown}
            onInput=${(/** @type {any} */ e) => setHouseholdDraft(e.currentTarget.value)}
          />
        </div>
        <div class="actions">
          <button
            class="secondary"
            onClick=${saveHousehold}
            disabled=${!profile || householdDraft === null || householdShown.trim() === household}
          >
            MOVE HOUSE
          </button>
        </div>
        <div class="row">
          <span class="k">In this house</span>
          <span class="status dim">
            ${
              housemates.length > 0
                ? housemates
                    .map((h) => {
                      const m = normalizeHousehold(houseDoc).members.find((x) => x.id === h.id);
                      const roles = m && m.roles.length > 0 ? ` (${m.roles.join(", ")})` : "";
                      return `${h.emoji ?? ""} ${h.name}${roles}`;
                    })
                    .join(" · ")
                : "…"
            }
          </span>
        </div>
        ${
          outsiders.length > 0 &&
          html`<div class="row">
              <span class="k">Add housemate</span>
              <select
                aria-label="Profile to add to this house"
                value=${addPick}
                onChange=${(/** @type {any} */ e) => setAddPick(e.currentTarget.value)}
              >
                <option value="">choose…</option>
                ${outsiders.map(
                  (o) => html`<option key=${o.id} value=${o.id}>${o.emoji ?? ""} ${o.name}</option>`,
                )}
              </select>
            </div>
            <div class="actions">
              <button class="secondary" onClick=${addMember} disabled=${!addPick || houseBusy}>
                ADD TO THIS HOUSE
              </button>
            </div>`
        }
        <div class="row">
          <span class="k">Rename house</span>
          <input
            aria-label="New name for this house, moves everyone in it"
            placeholder=${household}
            value=${renameDraft}
            onInput=${(/** @type {any} */ e) => setRenameDraft(e.currentTarget.value)}
          />
        </div>
        <div class="actions">
          <button
            class="secondary"
            onClick=${renameHouse}
            disabled=${houseBusy || !slugify(renameDraft) || slugify(renameDraft) === household}
          >
            RENAME FOR EVERYONE
          </button>
        </div>
        ${houseNote && html`<p class="hint" role="status">${houseNote}</p>`}
        <h3>Your kitchen</h3>
        <p class="hint">
          Tick what you actually own. Mise will stop offering food you cannot cook, and adding a
          thing opens more of the bank. Leave every box unticked and nothing is filtered, which is
          how it behaved before you told it anything.
        </p>
        <div class="gear-grid">
          ${EQUIPMENT.map(
            (e) => html`<label class="gear-item" key=${e.id}>
              <input
                type="checkbox"
                checked=${gear.includes(e.id)}
                onChange=${() => toggleGear(e.id)}
              />
              <span>
                ${e.label}
                ${e.note ? html`<small class="hint"> — ${e.note}</small>` : null}
              </span>
            </label>`,
          )}
        </div>
        <div class="row">
          <span class="k">Cookable with this kitchen</span>
          <span class="status num"
            >${cookableNow} of ${bank.length} · ${dinnersNow}/${totalDinners} dinners</span
          >
        </div>
        ${
          undeclared
            ? html`<p class="hint">
                Nothing declared yet, so everything is offered. Tick a box and this becomes what
                YOUR kitchen can cook.
              </p>`
            : null
        }
        ${
          dinnersNow === 0 && !undeclared
            ? html`<p class="hint">
                ⚠️ Nothing in the bank is a dinner you can cook with this. A microwave alone cannot
                make any of them, and an empty kitchen certainly cannot — you need at least a
                burner and a pan.
              </p>`
            : null
        }
        ${
          unlocks.length > 0
            ? html`<p class="hint">
                ${"What one more thing would open: "}
                ${unlocks
                  .slice(0, 4)
                  .map((u) => `${u.label} +${u.unlocks}`)
                  .join(" · ")}
              </p>`
            : null
        }
        <div class="actions">
          <button class="secondary" onClick=${saveGear} disabled=${gearDraft === null || gearBusy}>
            ${gearBusy ? "SAVING…" : "SAVE KITCHEN"}
          </button>
        </div>
        ${gearNote ? html`<p class="hint">${gearNote}</p>` : null}

        <p class="hint">
          a house is a physical kitchen: everyone in the same house shares the EVERYONE grocery trip
          AND the pantry (one kitchen, one fridge). Moving house also switches you to that house's
          pantry. Move someone for a visit week, move them back after.
        </p>
        <div class="row">
          <span class="k">Family</span>
          <input
            aria-label="Family this person belongs to"
            placeholder="e.g. taranowski"
            value=${familyShown}
            onInput=${(/** @type {any} */ e) => setFamilyDraft(e.currentTarget.value)}
          />
        </div>
        <div class="actions">
          <button
            class="secondary"
            onClick=${saveFamily}
            disabled=${!profile || familyDraft === null || familyShown.trim() === family}
          >
            SET FAMILY
          </button>
        </div>
        <p class="hint">
          family is who you ARE, a house is the kitchen you cook and shop from right now. The
          profile chooser groups people by family; houses can change week to week.
        </p>
        ${
          profilesFallback &&
          html`<p class="hint">
            ⚠ profile list couldn't load (offline or token not set), showing the built-in default.
            Other profiles still exist and are safe; profile edits are blocked until the real list
            loads.
          </p>`
        }
        ${profileErr && html`<p class="hint">⚠ ${profileErr}</p>`}
      </div>

      <div class="tile">
        <h2 class="k">Occasions</h2>
        <div class="row">
          <span class="k">Days off the plan</span>
          <a class="secondary" href="#/occasions">OCCASIONS</a>
        </div>
        <p class="hint">
          A medical prep, a holiday, travel, a race. Set the date and the app stops planning those
          days, follows a fixed script instead, and takes that person off shared tables while it
          runs.
        </p>
      </div>

      <div class="tile">
        <h2 class="k">Tour</h2>
        <div class="row tourrow">
          <span class="k">Guided tour</span>
          <button class="secondary" onClick=${onReplayTour}>REPLAY THE TOUR</button>
        </div>
        ${
          tourState &&
          html`<p class="hint num">
            last run:
            ${tourState.status === "done" ? "finished" : `reached step ${tourState.lastStep} of ${TOUR_STEPS.length}`}
          </p>`
        }
        <details class="whatlist">
          <summary class="block-title">What everything does</summary>
          ${Object.entries(TOUR_TABS).map(
            ([route, tab]) => html`
              <div class="batch" key=${route}>
                <div class="k">${tab}</div>
                ${TOUR_STEPS.filter((st) => st.route === route).map(
                  (st) =>
                    html`<div class="whatitem" key=${st.selector}>
                      <b>${st.title}.</b> ${st.text}
                    </div>`,
                )}
              </div>
            `,
          )}
        </details>
      </div>

      <div class="tile">
        <h2 class="k">Sync</h2>
        <div class="row">
          <span class="k">Queued writes</span>
          ${
            sync.loading
              ? html`<span class="status dim">…</span>`
              : sync.flushing
                ? html`<span class="status num dim">syncing…</span>`
                : html`<span class="status num ${sync.pending ? "warn" : "ok"}"
                    >${sync.pending}</span
                  >`
          }
        </div>
        ${
          sync.lastError &&
          sync.pending > 0 &&
          html`<div class="row">
            <span class="k">Last push error</span>
            <span class="status warn">${sync.lastError}</span>
          </div>`
        }
        <div class="row">
          <span class="k">Conflicts</span>
          ${
            sync.loading
              ? html`<span class="status dim">…</span>`
              : html`<span class="status num ${sync.conflicts ? "bad" : "ok"}"
                  >${sync.conflicts}</span
                >`
          }
        </div>
        <div class="row">
          <span class="k">Last sync</span>
          <span class="status num dim"
            >${sync.loading ? "…" : formatSyncTime(sync.lastSyncAt)}</span
          >
        </div>
        ${
          (repo?.auth === "invalid" || repo?.auth === "norepo") &&
          sync.pending > 0 &&
          html`<p class="hint">Not syncing — your access token needs fixing (see below).</p>`
        }
        <div class="actions">
          <button class="primary" onClick=${onTestWrite}>TEST SYNC WRITE</button>
        </div>
        <p class="hint">
          Writes a timestamp to meta.json in the data repo. Works offline — it queues and pushes
          when signal returns.
        </p>
        <div class="actions">
          <button class="secondary" onClick=${onExport}>⬇ EXPORT MY DATA</button>
        </div>
        <p class="hint">
          Downloads this profile's data (targets, pantry, list, plans, logs, own recipes) as one
          JSON file — your offline backup, works from the local cache even without signal.
        </p>
        <div class="actions">
          <button class="secondary" disabled=${notify === "busy"} onClick=${runNotifyTest}>
            ${notify === "busy" ? "TESTING…" : "🔔 TEST NOTIFICATIONS"}
          </button>
        </div>
        <p class="hint">
          Sends one real ntfy ping to your phone and lists everything today's schedule would send
          (cook reminders, store run, batch day, check-in nags).
        </p>
        ${notifyErr && html`<p class="hint scanerr" role="status">${notifyErr}</p>`}
        ${
          notifyResult &&
          html`<div class="tile" role="status">
            <div class="k">
              ${notifyResult.pinged ? "✓ ping sent — check your phone" : "no ping"} ·
              ${
                notifyResult.cronReady
                  ? "hourly cron LIVE"
                  : notifyResult.topicSet
                    ? "cron waiting on MISE_DATA_TOKEN (Worker secret)"
                    : "cron waiting on NTFY_TOPIC + MISE_DATA_TOKEN (Worker secrets)"
              }
            </div>
            ${
              notifyResult.preview.length === 0
                ? html`<div class="d">
                    nothing scheduled today (no plan, or groceries not confirmed)
                  </div>`
                : notifyResult.preview.map(
                    (n) =>
                      html`<div class="d" key=${n.title + n.body}>
                        <b>${n.title}</b> — ${n.body}
                      </div>`,
                  )
            }
          </div>`
        }
      </div>

      <div class="tile">
        <h2 class="k">Data repo — ${DATA_REPO.owner}/${DATA_REPO.repo}</h2>
        <div class="row">
          <span class="k">Privacy</span>
          ${
            repo == null
              ? html`<span class="status dim">checking…</span>`
              : repo.privacy === "private"
                ? html`<span class="status ok">PRIVATE ✓</span>`
                : repo.privacy === "PUBLIC"
                  ? html`<span class="status bad">PUBLIC ✗</span>`
                  : html`<span class="status warn">unknown (offline?)</span>`
          }
        </div>
        <div class="row">
          <span class="k">Token</span>
          ${
            repo == null
              ? html`<span class="status dim">…</span>`
              : repo.auth === "ok"
                ? html`<span class="status ok">connected ✓</span>`
                : repo.auth === "missing"
                  ? html`<span class="status warn">not set</span>`
                  : repo.auth === "invalid"
                    ? html`<span class="status bad">invalid ✗</span>`
                    : repo.auth === "norepo"
                      ? html`<span class="status bad">no repo access ✗</span>`
                      : html`<span class="status warn">unverified (offline)</span>`
          }
        </div>
        ${
          renewSoon &&
          html`<p class="hint">
            ⚠ This token is nearly a year old — fine-grained tokens expire at 12 months. Create a
            fresh one now (github.com → Settings → Developer settings → Fine-grained tokens) and
            paste it below before the old one dies mid-week.
          </p>`
        }
        ${
          (!hasToken || repo?.auth === "invalid" || repo?.auth === "norepo" || renewSoon) &&
          html`
            ${
              repo?.auth === "invalid" &&
              html`<p class="hint">Your saved token stopped working — paste a new one.</p>`
            }
            ${
              repo?.auth === "norepo" &&
              html`<p class="hint">
                Your token is valid, but it cannot see ${DATA_REPO.owner}/${DATA_REPO.repo}. Do NOT
                make another token. Open github.com → Settings → Developer settings → Fine-grained
                tokens → this token → Repository access → <b>Only select repositories</b> → add
                ${DATA_REPO.repo}, and under Permissions set <b>Contents: Read and write</b>. Save.
                The token string does not change, so nothing needs re-pasting here.
              </p>`
            }
            <div class="token-form">
              <input
                type="password"
                aria-label="Fine-grained personal access token"
                placeholder="paste fine-grained PAT"
                value=${draft}
                onInput=${(/** @type {{ currentTarget: HTMLInputElement }} */ e) =>
                  onDraft(e.currentTarget.value)}
              />
              <button class="primary" onClick=${onSaveToken}>SAVE</button>
            </div>
            <p class="hint">
              Stored only on this device. Get one at github.com → Settings → Developer settings →
              Fine-grained tokens: access to the ${DATA_REPO.repo} repo only, Contents read/write,
              nothing else.
            </p>
          `
        }
        <div class="row">
          <span class="k">Data repo</span>
          <span class="status ${dataRepoOverridden() ? "warn" : "dim"} num">
            ${DATA_REPO.owner}/${DATA_REPO.repo}
          </span>
        </div>
        <div class="token-form">
          <input
            aria-label="Data repo override (owner/repo)"
            placeholder="owner/repo (friend groups)"
            value=${repoDraft}
            onInput=${(/** @type {any} */ e) => setRepoDraft(e.currentTarget.value)}
          />
          <button class="secondary" onClick=${applyDataRepo}>SWITCH REPO</button>
        </div>
        <p class="hint">
          friend groups (B4): each group lives in its OWN private repo with its own token. Switching
          wipes this device's local data, profile, and token, then reloads — you'll re-enter that
          group's token. Blank + SWITCH returns to the family repo.
        </p>
      </div>
    </div>
  `;
}
