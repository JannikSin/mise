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
// that the admin profile cannot be picked on a device without its passkey.
// Logic keeps the raw lists (tables, seat screens, the ledger need them);
// only what views render goes through these filters.

/** localStorage key: this device has been signed in as the admin before */
export const ADMIN_DEVICE_KEY = "mise.adminDevice";
/** localStorage key: the household this device last signed into */
export const DEVICE_HOUSE_KEY = "mise.deviceHouse";

/** @param {Record<string, any> | undefined | null} p */
export const isAdmin = (p) => p?.admin === true;

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
  return list.filter((p) => houseOf(p) === house || (seated.has(p.id) && !isAdmin(p)));
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
          events: {
            ...h.events,
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
    if (isAdmin(p)) return adminDevice || Boolean(p.adminKey);
    return deviceHouse !== null && houseOf(p) === deviceHouse;
  });
}

/**
 * A typed name on a fresh device: the profiles it could mean, never a list.
 * @param {Record<string, any>[]} profiles
 * @param {string} typed
 */
export function profilesNamed(profiles, typed) {
  const key = String(typed ?? "").trim().toLowerCase();
  if (!key) return [];
  return (profiles ?? []).filter(
    (p) => p.household !== "guesthouse" && String(p.name ?? "").trim().toLowerCase() === key,
  );
}

/** A passkey is 4 to 8 digits. @param {string} pin */
export const validPasskey = (pin) => /^\d{4,8}$/.test(String(pin ?? ""));

/**
 * The stored form of an admin passkey: a random salt and a PBKDF2-SHA-256
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
 * May this device switch into `target`? Non-admin rows: yes. The admin row:
 * with the right passkey, or, while no passkey is set yet, only on a device
 * that has been the admin before (where he sets one in Settings).
 * @param {Record<string, any> | undefined} target
 * @param {string} pin
 * @param {boolean} adminDevice
 */
export async function maySwitchTo(target, pin, adminDevice) {
  if (!target) return false;
  if (!isAdmin(target)) return true;
  if (!target.adminKey) return adminDevice;
  return checkAdminKey(target.adminKey, pin);
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
    { name: "PBKDF2", hash: "SHA-256", salt: /** @type {BufferSource} */ (salt), iterations: 10000 },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}
