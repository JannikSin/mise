// LINK A ROOMMATE (David, 2026-10-16: "click on a profile maybe and then link
// it to yourself, so like if you're roommates ... all the meals are like
// that"). The household half is the same write Settings' ADD TO THIS HOUSE
// made, moved here so the People tab and nothing else owns it: the person
// joins household.json as an eater and their profile points at this house.
// Deliberately NEVER writes a headId it did not read (reviewer finding 5,
// 2026-08-25): the read is cache-only, so a null here can mean "this device
// hasn't synced the file yet".
import { patchProfiles, read, write } from "./store.js";
import { householdPathFor, normalizeHousehold, setMemberRoles } from "./household.js";

/**
 * Put `id` in `household` as an eater and point their profile at it.
 * @param {string} household the house to join (the linker's own)
 * @param {string} me the person doing the linking (must be allowed to assign roles)
 * @param {string} id the person being linked
 * @returns {Promise<{ ok: boolean, note: string }>}
 */
export async function addHousemate(household, me, id) {
  const path = householdPathFor(household);
  const raw = /** @type {Record<string, any> | null} */ (await read(path, { raw: true }));
  const hh = normalizeHousehold(raw);
  const res = setMemberRoles(hh, me, id, ["eater"]);
  if (!res.changed && !hh.members.some((m) => m.id === id)) return { ok: false, note: res.reason };
  // the profile moves FIRST (Tribunal Realist, 2026-10-16): if the profile
  // list is unreachable nothing has been written yet, so "nobody moved" is
  // true; the household roster follows only once the move landed
  const ok = await patchProfiles((list) =>
    list.map((x) => {
      if (x.id !== id) return x;
      const rest = { ...x };
      delete rest.household;
      return household === "home" ? rest : { ...rest, household };
    }),
  );
  if (!ok) return { ok: false, note: "the profile list was unreachable, so nobody moved" };
  if (res.changed) {
    await write(path, { ...(raw ?? {}), members: res.household.members }, { raw: true });
  }
  return { ok: true, note: "linked: they now share this kitchen's meals, pantry and trip" };
}
