// WHO SEES WHOM (David, 2026-10-18: "I don't want everybody to see
// everybody's profile. Other than me, who should have admin privileges, no
// other profile should be able to see people not in their immediate place.
// Nobody in West Lafayette should be able to see my family."). P3 and P8.
//
// THE BOUNDARY IS IN THE APP, deliberately light ("not too much security,
// just a little bit of a boundary"). Anyone holding the data token can read
// the private repo directly, and the app downloads profiles.json and every
// household's events, so devtools or the offline cache can still show them.
// What this module guarantees is that no SCREEN shows a non-admin a profile
// outside their own household (plus guests seated at their own tables), and
// that a profile with a passkey (the admin's, and since v1.9 anyone's) cannot be
// picked on a device without it.
// Logic keeps the raw lists (tables, seat screens, the ledger need them);
// only what views render goes through these filters.

/** localStorage key: this device has been signed in as the admin before */
export const ADMIN_DEVICE_KEY = "mise.adminDevice";
/** localStorage key: the household this device last signed into */
export const DEVICE_HOUSE_KEY = "mise.deviceHouse";

/** @param {Record<string, any> | undefined | null} p */
export const isAdmin = (p) => p?.admin === true;

/**
 * A profile's own passkey (David, 2026-10-18: "everybody else should also
 * have their own passkey"). `passkey` since v1.9; v1.8 wrote `adminKey` on
 * the admin row only, still honoured so no older key is ever ignored.
 * @param {Record<string, any> | undefined | null} p
 * @returns {{ salt: string, hash: string } | undefined}
 */
export const keyOf = (p) => p?.passkey ?? p?.adminKey ?? undefined;

/**
 * localStorage key: this phone opened `id` through a real check (its passkey,
 * or a profile with none, from the real profile list). Tribunal Red Team,
 * 2026-10-18: an offline phone with an empty cache offered the built-in
 * David row with no passkey, one tap signed in, and the phone then marked
 * itself the admin's. Now a passkeyed profile that was never verified here
 * goes back to the chooser, and only a verified admin open marks the phone.
 * @param {string} id
 */
export const verifiedKey = (id) => `mise.verified.${id}`;

/** @param {Record<string, any> | undefined | null} p */
const houseOf = (p) => String(p?.household ?? "home");

/**
 * Before any profile is marked admin (the release writes admin:true on
 * David's row), nothing is hidden: hiding his own family from him would be
 * the worse failure. Once a row says admin, the boundary applies.
 * @param {Record<string, any>[]} profiles
 */
export function boundaryOn(profiles) {
  return (profiles ?? []).some(isAdmin);
}

/**
 * The profiles a person's screens may show: their own household, plus guests
 * seated at their own household's tables from today through the next 14
 * days. The admin sees everyone; with no admin set yet, everyone does.
 * @param {Record<string, any>[]} profiles the raw list
 * @param {string} me
 * @param {{ house: string, events: { tables?: any[] } }[]} houseEvents
 * @param {string} todayIso
 * @returns {Record<string, any>[]}
 */
export function visibleProfilesFor(profiles, me, houseEvents, todayIso) {
  const list = profiles ?? [];
  const mine = list.find((p) => p.id === me);
  if (!boundaryOn(list) || isAdmin(mine)) return list;
  const house = houseOf(mine);
  const until = plusDays(todayIso, 14);
  /** @type {Set<string>} */
  const seated = new Set();
  for (const h of houseEvents ?? []) {
    if (h.house !== house) continue;
    for (const t of h.events?.tables ?? []) {
      if (!t || t.date < todayIso || t.date > until) continue;
      for (const s of t.seats ?? []) if (s?.id) seated.add(String(s.id));
    }
  }
  // anyone seated at your own table is already known to you, the admin too
  // (Tribunal Realist: Mom would otherwise see David's seat as "david")
  return list.filter((p) => houseOf(p) === house || seated.has(p.id));
}

/**
 * The house events a person's screens may show: their own household's file
 * whole, and from any other household only the tables they are seated at.
 * @param {{ house: string, events: Record<string, any> }[]} houseEvents
 * @param {Record<string, any>[]} profiles
 * @param {string} me
 */
export function visibleHouseEventsFor(houseEvents, profiles, me) {
  const mine = (profiles ?? []).find((p) => p.id === me);
  if (!boundaryOn(profiles) || isAdmin(mine)) return houseEvents;
  const house = houseOf(mine);
  return (houseEvents ?? []).map((h) =>
    h.house === house
      ? h
      : {
          house: h.house,
          // an allow-list, never a spread: only the tables you sit at
          events: {
            brigades: [],
            tables: (h.events?.tables ?? []).filter((/** @type {any} */ t) =>
              (t?.seats ?? []).some((/** @type {any} */ s) => s?.id === me),
            ),
          },
        },
  );
}

/**
 * The rows a profile chooser may list on this device: only the household the
 * device last signed into (none on a fresh device: it asks for a name
 * instead). The admin row is listed only where the device has been the
 * admin before or a passkey exists to unlock it.
 * @param {Record<string, any>[]} profiles
 * @param {string | null} deviceHouse
 * @param {boolean} adminDevice
 */
export function chooserProfiles(profiles, deviceHouse, adminDevice) {
  const list = (profiles ?? []).filter((p) => p.household !== "guesthouse");
  if (!boundaryOn(profiles)) return list;
  return list.filter((p) => {
    if (isAdmin(p)) return adminDevice || Boolean(keyOf(p));
    return deviceHouse !== null && houseOf(p) === deviceHouse;
  });
}

/**
 * A typed name on a fresh device: the profiles it could mean, never a list.
 * @param {Record<string, any>[]} profiles
 * @param {string} typed
 */
export function profilesNamed(profiles, typed) {
  const key = String(typed ?? "")
    .trim()
    .toLowerCase();
  if (!key) return [];
  // never the admin row: his profile opens from the list with its passkey
  return (profiles ?? []).filter(
    (p) =>
      p.household !== "guesthouse" &&
      !isAdmin(p) &&
      String(p.name ?? "")
        .trim()
        .toLowerCase() === key,
  );
}

/**
 * The household a NEW profile made on this device may join (Tribunal Red
 * Team, 2026-10-18: "+ add profile" with a typed house put anyone into the
 * family). Once the boundary is on, only the admin's device chooses; every
 * other device creates in its own house ("home" on a fresh device).
 * @param {Record<string, any>[]} profiles
 * @param {string | null} deviceHouse
 * @param {boolean} adminDevice
 * @param {string} typed
 */
export function allowedNewHouse(profiles, deviceHouse, adminDevice, typed) {
  if (!boundaryOn(profiles) || adminDevice) return typed;
  return deviceHouse ?? "home";
}

/**
 * The occasions a person's screens may show: only those of profiles they may
 * see (Tribunal Red Team: every household's occasions reached the view).
 * @param {{ profileId: string }[]} occasions
 * @param {Record<string, any>[]} visible
 */
export function visibleOccasionsFor(occasions, visible) {
  const ids = new Set((visible ?? []).map((p) => p.id));
  return (occasions ?? []).filter((o) => ids.has(o.profileId));
}

/**
 * What a passkey box keeps of what was typed: digits only, at most 8. Phones
 * paste spaces and full-width digits; NFKC turns those into plain digits.
 * @param {unknown} raw
 */
export const cleanPasskey = (raw) =>
  String(raw ?? "")
    .normalize("NFKC")
    .replace(/\D/g, "")
    .slice(0, 8);

/** A passkey is 4 to 8 digits. @param {string} pin */
export const validPasskey = (pin) => /^\d{4,8}$/.test(String(pin ?? ""));

/**
 * The stored form of a profile's passkey (the name is v1.8 legacy: since
 * v1.9 it serves EVERY profile, not only the admin's): a random salt and a PBKDF2-SHA-256
 * hash (10,000 rounds, the same light bar as the guest login).
 * @param {string} pin
 * @param {Uint8Array} [salt] injectable for tests
 * @returns {Promise<{ salt: string, hash: string }>}
 */
export async function makeAdminKey(pin, salt = crypto.getRandomValues(new Uint8Array(16))) {
  return { salt: hex(salt), hash: await derive(pin, salt) };
}

/**
 * @param {{ salt?: string, hash?: string } | undefined | null} key
 * @param {string} pin
 */
export async function checkAdminKey(key, pin) {
  if (!key?.salt || !key?.hash || !validPasskey(pin)) return false;
  const salt = new Uint8Array((key.salt.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  return (await derive(pin, salt)) === key.hash;
}

/**
 * May this device switch into `target`? A profile with its own passkey: only
 * with it. Without one: yes, except the admin row, which then opens only on a
 * device that has been the admin before (where he sets one in Settings).
 * A profile from ANOTHER household than this device's (Tribunal Red Team,
 * 2026-10-18: Elliot typing "Mom" became Mom) also needs the admin's
 * passkey, unless this is the admin's own device.
 * @param {Record<string, any> | undefined} target
 * @param {string} pin
 * @param {boolean} adminDevice
 * @param {{ profiles?: Record<string, any>[], deviceHouse?: string | null }} [where]
 */
export async function maySwitchTo(target, pin, adminDevice, where = {}) {
  if (!target) return false;
  const list = where.profiles ?? [];
  if (
    !isAdmin(target) &&
    boundaryOn(list) &&
    !adminDevice &&
    where.deviceHouse &&
    houseOf(target) !== where.deviceHouse
  ) {
    return checkAdminKey(keyOf(list.find(isAdmin)), pin);
  }
  // a profile with its own passkey opens only with it, on any phone
  if (keyOf(target)) return checkAdminKey(keyOf(target), pin);
  return isAdmin(target) ? adminDevice : true;
}

/** @param {string} iso @param {number} n */
function plusDays(iso, n) {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} pin @param {Uint8Array} salt */
async function derive(pin, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(pin)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: /** @type {BufferSource} */ (salt),
      iterations: 10000,
    },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

/**
 * What this phone may SYNC (Mise 2.0, A-03), as opposed to what its screens
 * show: null = everything (no admin set yet, or the admin's own profile);
 * otherwise its own household's profiles and that household's files. Guests
 * seated at its tables are added by the caller once the events load.
 * @param {Record<string, any>[]} profiles
 * @param {string} me
 * @returns {{ profileIds: string[], houses: string[] } | null}
 */
export function syncScopeFor(profiles, me) {
  const list = profiles ?? [];
  const mine = list.find((p) => p.id === me);
  if (!boundaryOn(list) || !mine || isAdmin(mine)) return null;
  const house = houseOf(mine);
  return {
    profileIds: list.filter((p) => houseOf(p) === house).map((p) => String(p.id)),
    houses: [house],
  };
}

/**
 * A recipe title never names someone this phone does not show (2.0, A-03:
 * Elliot's Cookbook listed "Laurie's Mediterranean Herb Chicken"). Drops a
 * leading "<Name>'s " for each hidden name; display only, the bank is
 * untouched. Returns the same array when nothing changes.
 * @param {Record<string, any>[]} recipes
 * @param {string[]} hiddenNames
 * @returns {Record<string, any>[]}
 */
export function withoutHiddenNames(recipes, hiddenNames) {
  const names = hiddenNames.map((n) => String(n ?? "").trim()).filter(Boolean);
  if (names.length === 0) return recipes;
  const esc = (/** @type {string} */ x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = new RegExp(`^(?:${names.map(esc).join("|")})['’]s\\s+`, "i");
  let changed = false;
  const out = recipes.map((r) => {
    const name = String(r?.name ?? "");
    if (!lead.test(name)) return r;
    changed = true;
    const rest = name.replace(lead, "");
    return { ...r, name: rest.charAt(0).toUpperCase() + rest.slice(1) };
  });
  return changed ? out : recipes;
}
