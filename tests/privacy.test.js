// WHO SEES WHOM (David, 2026-10-18). P3, P8. Two households, a guest, one
// admin: a non-admin's screens show their own house plus a guest seated at
// their own table, never the other house; the admin row needs its passkey.
import test from "node:test";
import assert from "node:assert/strict";
import {
  visibleProfilesFor,
  visibleHouseEventsFor,
  chooserProfiles,
  profilesNamed,
  makeAdminKey,
  checkAdminKey,
  maySwitchTo,
  boundaryOn,
} from "../app/lib/privacy.js";

const PROFILES = [
  { id: "david", name: "David", household: "wayne", admin: true },
  { id: "elliot", name: "Elliot", household: "wayne" },
  { id: "mom", name: "Mom", household: "thornton" },
  { id: "dad", name: "Dad", household: "thornton" },
  { id: "priya", name: "Priya", household: "guesthouse" },
  { id: "sam", name: "Sam", household: "guesthouse" },
];
const TODAY = "2026-10-18";
const EVENTS = [
  {
    house: "wayne",
    events: {
      tables: [{ id: "t1", date: "2026-10-20", seats: [{ id: "david" }, { id: "elliot" }, { id: "priya" }] }],
    },
  },
  {
    house: "thornton",
    events: {
      brigades: [{ id: "fam" }],
      tables: [
        { id: "t2", date: "2026-10-19", seats: [{ id: "mom" }, { id: "dad" }, { id: "sam" }] },
        { id: "t3", date: "2026-10-21", seats: [{ id: "mom" }, { id: "elliot" }] },
      ],
    },
  },
];
const ids = (/** @type {any[]} */ l) => l.map((p) => p.id).sort();

test("a non-admin sees their own house and the guest at their table, never the other house", () => {
  assert.deepEqual(ids(visibleProfilesFor(PROFILES, "elliot", EVENTS, TODAY)), ["david", "elliot", "priya"]);
});

test("the admin sees everyone; before any admin is marked, nothing is hidden", () => {
  assert.equal(visibleProfilesFor(PROFILES, "david", EVENTS, TODAY).length, PROFILES.length);
  const noAdmin = PROFILES.map(({ admin: _a, ...p }) => p);
  assert.equal(boundaryOn(noAdmin), false);
  assert.equal(visibleProfilesFor(noAdmin, "elliot", EVENTS, TODAY).length, PROFILES.length);
});

test("another house's events show only the tables you are seated at, and none of its rules", () => {
  const seen = visibleHouseEventsFor(EVENTS, PROFILES, "elliot");
  const fam = seen.find((h) => h.house === "thornton");
  assert.deepEqual(fam?.events.tables.map((t) => t.id), ["t3"]);
  assert.deepEqual(fam?.events.brigades, [], "an allow-list: nothing but your tables");
  assert.deepEqual(Object.keys(fam?.events ?? {}).sort(), ["brigades", "tables"]);
  assert.equal(seen.find((h) => h.house === "wayne")?.events.tables.length, 1);
});

test("the chooser never lists another household, and a fresh device lists no one", () => {
  assert.deepEqual(ids(chooserProfiles(PROFILES, "wayne", false)), ["elliot"], "the admin row stays hidden on a roommate's phone");
  assert.deepEqual(ids(chooserProfiles(PROFILES, null, false)), [], "a fresh device asks for a name instead");
  assert.deepEqual(ids(chooserProfiles(PROFILES, "wayne", true)), ["david", "elliot"], "his own phone");
  assert.deepEqual(ids(profilesNamed(PROFILES, "  mom ")), ["mom"]);
  assert.deepEqual(profilesNamed(PROFILES, "priya"), [], "guests never sign in from the chooser");
});

test("picking the admin row needs its passkey once one is set", async () => {
  const key = await makeAdminKey("2468", new Uint8Array(16).fill(7));
  const david = { ...PROFILES[0], adminKey: key };
  assert.equal(await maySwitchTo(david, "", false), false, "no passkey, no switch");
  assert.equal(await maySwitchTo(david, "1357", true), false, "a wrong passkey fails even on his phone");
  assert.equal(await maySwitchTo(david, "2468", false), true);
  assert.equal(await checkAdminKey(key, "24680"), false);
  assert.equal(await maySwitchTo(PROFILES[0], "", false), false, "unset passkey: only a device that has been the admin");
  assert.equal(await maySwitchTo(PROFILES[0], "", true), true);
  assert.equal(await maySwitchTo(PROFILES[1], "", false), true, "a non-admin row needs nothing");
});

test("Red Team 2026-10-18: Elliot's phone cannot type its way into Mom, nor add a profile to the family", async () => {
  const { allowedNewHouse, visibleOccasionsFor } = await import("../app/lib/privacy.js");
  const key = await makeAdminKey("2468", new Uint8Array(16).fill(3));
  const withKey = PROFILES.map((p) => (p.id === "david" ? { ...p, adminKey: key } : p));
  const mom = withKey.find((p) => p.id === "mom");
  const where = { profiles: withKey, deviceHouse: "wayne" };
  assert.equal(await maySwitchTo(mom, "", false, where), false, "another household without the passkey");
  assert.equal(await maySwitchTo(mom, "1111", false, where), false);
  assert.equal(await maySwitchTo(mom, "2468", false, where), true, "the admin's passkey opens it");
  assert.equal(await maySwitchTo(withKey[1], "", false, where), true, "own house: no passkey");
  assert.deepEqual(profilesNamed(withKey, "david"), [], "the admin row is never found by name");
  assert.equal(allowedNewHouse(withKey, "wayne", false, "thornton"), "wayne", "a new profile joins the device's house");
  assert.equal(allowedNewHouse(withKey, null, false, "thornton"), "home");
  assert.equal(allowedNewHouse(withKey, "wayne", true, "thornton"), "thornton", "the admin's device chooses");
  const occ = [{ profileId: "mom" }, { profileId: "elliot" }, { profileId: "priya" }];
  const vis = visibleProfilesFor(withKey, "elliot", EVENTS, TODAY);
  assert.deepEqual(visibleOccasionsFor(occ, vis).map((o) => o.profileId), ["elliot", "priya"]);
});

test("Realist 2026-10-18: someone seated at your own table is visible, the admin included", () => {
  const ev = [{ house: "thornton", events: { tables: [{ id: "x", date: "2026-10-19", seats: [{ id: "mom" }, { id: "david" }] }] } }];
  assert.ok(visibleProfilesFor(PROFILES, "mom", ev, TODAY).some((p) => p.id === "david"));
});

test("Tribunal loop 2: a household typed into the CHAT still lands in the device's own house", async () => {
  const { allowedNewHouse } = await import("../app/lib/privacy.js");
  const profiles = [
    { id: "david", household: "wayne", admin: true },
    { id: "elliot", household: "wayne" },
    { id: "mom", household: "thornton" },
  ];
  assert.equal(allowedNewHouse(profiles, "wayne", false, "thornton"), "wayne");
  assert.equal(allowedNewHouse(profiles, null, false, "thornton"), "home");
  assert.equal(allowedNewHouse(profiles, "wayne", true, "thornton"), "thornton", "the admin device may place anywhere");
});

test("v1.9: everyone may have a passkey, and a profile with one opens only with it (David, 2026-10-18)", async () => {
  const { keyOf } = await import("../app/lib/privacy.js");
  const key = await makeAdminKey("0042", new Uint8Array(16).fill(5));
  const elliot = { ...PROFILES[1], passkey: key };
  assert.equal(await maySwitchTo(elliot, "", false), false, "a passkeyed housemate needs it");
  assert.equal(await maySwitchTo(elliot, "42", false), false, "leading zeros are part of the passkey");
  assert.equal(await maySwitchTo(elliot, "0042", false), true);
  const david = { ...PROFILES[0], passkey: key };
  assert.equal(await maySwitchTo(david, "0042", false), true, "the admin's passkey under the v1.9 name");
  assert.deepEqual(keyOf({ adminKey: key }), key, "a v1.8 adminKey is still honoured");
  assert.equal(keyOf({ id: "x" }), undefined);
  assert.ok(
    chooserProfiles([david, PROFILES[1]], "wayne", false).some((p) => p.id === "david"),
    "the admin row is listed once it has a passkey under either name",
  );
});

test("v1.9: the passkey box keeps digits only (spaces, full-width digits, pasted dashes)", async () => {
  const { cleanPasskey } = await import("../app/lib/privacy.js");
  assert.equal(cleanPasskey(" 12 34 "), "1234");
  assert.equal(cleanPasskey("１２３４"), "1234", "full-width digits from a phone keyboard");
  assert.equal(cleanPasskey("12-34-5678-9"), "12345678", "at most 8");
  assert.equal(cleanPasskey(undefined), "");
});
