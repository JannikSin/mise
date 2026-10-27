// An in-memory stand-in for the slice of supabase-js the Supabase adapter
// calls, with write_doc's rev and conflict rules from plan section 4.2. It is
// not a policy test (the db lane's PGlite suite is); hooks let a test say
// what the server would refuse.

/**
 * @param {{
 *   canWrite?: (path: string) => boolean,
 *   nameGuard?: (path: string, data: any) => boolean,
 *   isAdmin?: () => boolean,
 *   failWith?: (op: string, path: string) => { code?: string, message?: string, status?: number } | null,
 *   plateOf?: (targets: any) => any,
 *   rootSlug?: string,
 * }} [hooks]
 */
export function fakeSupabase(hooks = {}) {
  /** @type {Map<string, { path: string, data: any, rev: number, legacy_sha: string | null }>} */
  const docs = new Map();
  /** @type {Map<string, { id: string, data: any, rev: number, legacy_sha: string | null, staging: boolean }>} */
  const recipes = new Map();
  /** plates by owner slug */
  /** @type {Map<string, { data: any, rev: number, content_hash: string, legacy_sha: string | null }>} */
  const plates = new Map();
  const roster = { profiles: /** @type {any[]} */ ([]), rev: 1 };
  /** every query and call, in order */
  /** @type {{ op: string, table?: string, filters?: any[], args?: any }[]} */
  const log = [];
  const canWrite = hooks.canWrite ?? (() => true);
  const nameGuard = hooks.nameGuard ?? (() => false);
  const isAdmin = hooks.isAdmin ?? (() => true);
  const failWith = hooks.failWith ?? (() => null);

  // targets_after, in miniature: a targets write refreshes the owner's plate,
  // and an unchanged projection leaves the plate (and its rev) alone
  /** @param {string} path @param {any} data */
  const refreshPlate = (path, data) => {
    if (!hooks.plateOf) return;
    const m = /^profiles\/([a-z0-9-]+)\/(?:profile|fitness)\/targets\.json$/.exec(path);
    const owner = m ? m[1] : path === "profile/targets.json" ? hooks.rootSlug : undefined;
    if (!owner) return;
    const v = hooks.plateOf(data);
    const cur = plates.get(owner);
    const hash = JSON.stringify(v);
    if (cur && JSON.stringify(cur.data) === hash) return;
    plates.set(owner, {
      data: v,
      rev: cur ? cur.rev + 1 : 1,
      content_hash: `h${hash.length}-${[...hash].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`,
      legacy_sha: cur?.legacy_sha ?? null,
    });
  };

  /** @param {string} pattern */
  const likeToRegex = (pattern) => {
    let src = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = /** @type {string} */ (pattern[i]);
      if (ch === "\\") src += (pattern[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (ch === "%") src += ".*";
      else if (ch === "_") src += ".";
      else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${src}$`);
  };

  /** @param {string} table */
  function from(table) {
    /** @type {((row: any) => boolean)[]} */
    const tests = [];
    /** @type {any[]} */
    const filters = [];
    const rows = () => {
      const all =
        table === "docs" ? [...docs.values()] : table === "recipes" ? [...recipes.values()] : [];
      return all.filter((r) => tests.every((t) => t(r))).map((r) => structuredClone(r));
    };
    const done = (/** @type {(rows: any[]) => any} */ shape) => {
      log.push({ op: "select", table, filters });
      const err = failWith("select", String(filters[0]?.[2] ?? table));
      if (err) return Promise.resolve({ data: null, error: err });
      return Promise.resolve({ data: shape(rows()), error: null });
    };
    const q = {
      select: () => q,
      eq: (/** @type {string} */ col, /** @type {any} */ v) => {
        filters.push(["eq", col, v]);
        tests.push((r) => r[col] === v);
        return q;
      },
      like: (/** @type {string} */ col, /** @type {string} */ pattern) => {
        filters.push(["like", col, pattern]);
        const re = likeToRegex(pattern);
        tests.push((r) => re.test(String(r[col])));
        return q;
      },
      maybeSingle: () => done((rs) => rs[0] ?? null),
      then: (/** @type {any} */ ok, /** @type {any} */ bad) => done((rs) => rs).then(ok, bad),
    };
    return q;
  }

  /**
   * @param {string} name
   * @param {any} [args]
   */
  async function rpc(name, args) {
    log.push({ op: "rpc", table: name, args: structuredClone(args) });
    const err = failWith(name, String(args?.p_path ?? args?.p_slug ?? name));
    if (err) return { data: null, error: err };
    if (name === "roster") return { data: structuredClone(roster), error: null };
    if (name === "plate_for") {
      const p = plates.get(args.p_slug);
      return { data: p ? structuredClone(p) : null, error: null };
    }
    if (name !== "write_doc")
      return { data: null, error: { code: "42883", message: "no such function" } };
    const { p_path: path, p_data: data, p_expected_rev: expected } = args;
    const conflict = { data: null, error: { code: "P0409", message: "mise_conflict" } };
    const bank = /^(recipes|recipes-staging)\/([a-z0-9][a-z0-9-]*)\.json$/.exec(path);
    if (bank) {
      if (!isAdmin()) return { data: null, error: { code: "P0403", message: "mise_forbidden" } };
      if (nameGuard(path, data))
        return { data: null, error: { code: "P0422", message: "mise_name_guard" } };
      const id = String(bank[2]);
      const cur = recipes.get(id);
      const staging = bank[1] === "recipes-staging";
      if (expected == null) {
        if (cur) return conflict;
        recipes.set(id, { id, data, rev: 1, legacy_sha: null, staging });
        return { data: 1, error: null };
      }
      if (!cur || cur.rev !== expected) return conflict;
      recipes.set(id, { ...cur, data, staging, rev: cur.rev + 1 });
      return { data: cur.rev + 1, error: null };
    }
    if (path === "profiles.json") {
      if (expected !== roster.rev) return conflict;
      roster.profiles = data.profiles;
      roster.rev += 1;
      return { data: roster.rev, error: null };
    }
    if (!canWrite(path)) return { data: null, error: { code: "P0403", message: "mise_forbidden" } };
    if (nameGuard(path, data))
      return { data: null, error: { code: "P0422", message: "mise_name_guard" } };
    const cur = docs.get(path);
    if (expected == null) {
      if (cur) return conflict;
      docs.set(path, { path, data, rev: 1, legacy_sha: null });
      refreshPlate(path, data);
      return { data: 1, error: null };
    }
    if (!cur || cur.rev !== expected) return conflict;
    docs.set(path, { ...cur, data, rev: cur.rev + 1 });
    refreshPlate(path, data);
    return { data: cur.rev + 1, error: null };
  }

  return { client: { from, rpc }, docs, recipes, plates, roster, log };
}
