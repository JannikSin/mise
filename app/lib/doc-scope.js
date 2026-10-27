// Mise 2.0 (P1 to P12 all ride on it: the data has to land where only the right
// people can read it). The JS mirror of `private.doc_scope` in
// supabase/migrations/20261027090000_b1_tables_scope_triggers.sql: the same
// path in, the same kind and owner out, the same refusal. The migration uses it
// to classify a mise-data snapshot before it writes, and tests/doc-scope.test.js
// runs this and the SQL over one path list and requires identical answers.
// Change both together.

/** House files bound to a house by their path. */
export const HOUSE_FILE_KINDS = Object.freeze([
  "events",
  "ledger",
  "pantry",
  "pantry-notes",
  "waste",
  "household",
  "prices",
  "pins",
]);

const SEG = "[a-z0-9][a-z0-9-]{0,80}";
const PATH_OK = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}\.json$/;
const HOUSE_FILE = new RegExp(`^households/(${SEG})/(${HOUSE_FILE_KINDS.join("|")})\\.json$`);
const HOUSE_RECIPE = new RegExp(`^households/(${SEG})/recipes/(house-[0-9a-f]{12})\\.json$`);
const GLOBAL = new RegExp(`^philosophies/${SEG}\\.json$`);
const PROFILE = new RegExp(`^profiles/(${SEG})/(.+)$`);
const ROOT_PERSONAL = /^(plans\/|profile\/|shopping\.json$|occasions\.json$|pantry\.json$)/;
const OWN_RECIPE = new RegExp(`^recipes/${SEG}\\.json$`);

/**
 * @typedef {{ kind: string, profile: string | null, household: string | null }} DocScope
 * @typedef {{ households: Iterable<string>, profiles: Iterable<string>, rootProfile: string | null }} ScopeWorld
 *   the slugs that exist, and `private.settings.root_profile`
 */

/** Thrown for every path the database would refuse, whatever the reason. */
export class BadPathError extends Error {
  constructor() {
    super("mise_bad_path");
    this.name = "BadPathError";
  }
}

/**
 * Where a former mise-data file lives as a `docs` row.
 * @param {string} p a data-repo path
 * @param {ScopeWorld} world
 * @returns {DocScope}
 */
export function docScope(p, world) {
  if (typeof p !== "string" || !PATH_OK.test(p) || /\.\.|\/\//.test(p)) throw new BadPathError();
  const houses = new Set(world.households);
  const people = new Set(world.profiles);
  let m = HOUSE_FILE.exec(p);
  if (m) {
    if (!houses.has(String(m[1]))) throw new BadPathError();
    return { kind: String(m[2]), profile: null, household: String(m[1]) };
  }
  m = HOUSE_RECIPE.exec(p);
  if (m) {
    if (!houses.has(String(m[1]))) throw new BadPathError();
    return { kind: "house_recipe", profile: null, household: String(m[1]) };
  }
  if (GLOBAL.test(p)) return { kind: "global", profile: null, household: null };
  /** @type {string | null} */
  let owner;
  let rest;
  m = PROFILE.exec(p);
  if (m) {
    owner = String(m[1]);
    rest = String(m[2]);
  } else if (/^(fitness|health)\//.test(p)) {
    throw new BadPathError();
  } else if (ROOT_PERSONAL.test(p)) {
    owner = world.rootProfile;
    rest = p;
  } else {
    throw new BadPathError();
  }
  if (owner === null || !people.has(owner)) throw new BadPathError();
  const kind =
    rest === "profile/targets.json" || rest === "fitness/targets.json"
      ? "targets"
      : /^(fitness|health)\//.test(rest)
        ? "health"
        : /^plans\/[0-9]{4}-W[0-9]{2}\.json$/.test(rest)
          ? "plan"
          : rest === "shopping.json"
            ? "shopping"
            : rest === "occasions.json"
              ? "occasions"
              : rest === "pantry.json"
                ? "pantry"
                : OWN_RECIPE.test(rest)
                  ? "own_recipe"
                  : null;
  if (kind === null) throw new BadPathError();
  return { kind, profile: owner, household: null };
}

/**
 * Who can read a row of this scope, as house slugs (the name guard's
 * audience); null = owner and admin only, or everyone for `global`.
 * Mirrors `private.audience`.
 * @param {DocScope} s
 * @param {(slug: string) => string[]} housesOf a person's houses
 * @returns {string[] | null}
 */
export function audienceOf(s, housesOf) {
  if (s.household !== null) return [s.household];
  if (["plan", "shopping", "occasions", "pantry", "own_recipe"].includes(s.kind) && s.profile)
    return housesOf(s.profile);
  return null;
}
