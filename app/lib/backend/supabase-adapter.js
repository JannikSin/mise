// THE SUPABASE ADAPTER (Mise 2.0, plan section 5). Talks to the tables and
// functions of supabase/schema.sql (the db lane owns that file) through an
// injected client, so tests run against a fake and nothing here imports a
// vendored library.
//
// The client is the subset of supabase-js this file calls:
//   client.from(table).select(cols).eq(col, v).maybeSingle()   one row
//   client.from(table).select(cols).eq(col, v)                 rows (awaited)
//   client.from(table).select(cols).like(col, pattern)         rows (awaited)
//   client.rpc(name, args)                                     a function call
// each resolving to { data, error } with error.code the Postgres errcode.
//
// THE SHA RULE (plan item 9). A row's sha is
//   rev === 1 ? (legacy_sha ?? "pg:1") : "pg:" + rev
// so a migrated row keeps reading as its git sha until its first edit, and a
// 1.95 record queued against that sha still lands as an ordinary edit. On a
// write the sha maps back to the rev write_doc expects: "pg:N" is N, the
// row's own legacy_sha is 1, anything else (a stale git sha, a plate sha) is
// sent as a create, which conflicts on an existing row and takes the merge
// path.
//
// TARGETS READS (ENG L2-2). Who is asking decides, never what came back:
// the owner, or the admin, always reads the full docs row; anyone else reads
// the owner's plate (the cook-facing projection). An empty full read never
// falls back to a plate, and a non-owner never asks for the full row.

import { ConflictError, ForbiddenError, NameGuardError, AuthError } from "./errors.js";
import { ROOT_PROFILE } from "./config.js";

/**
 * @typedef {{ data: any, error: { code?: string, message?: string, status?: number } | null }} SbResult
 * @typedef {{
 *   from(table: string): any,
 *   rpc(name: string, args?: Record<string, unknown>): PromiseLike<SbResult>,
 * }} SupabaseLike
 * @typedef {{ data: Record<string, unknown>, rev: number, legacy_sha?: string | null }} DocRow
 * @typedef {{ data: Record<string, unknown>, rev: number, content_hash: string, legacy_sha?: string | null }} PlateRow
 */

// prices and pins are one per house now: the caller's home house (C2)
const HOUSE_FILES = /^(prices|pins)\.json$/;
// guest logins and invite codes are the Worker's alone; meta.json was a
// GitHub write test and is not migrated (plan section 6, step 4)
const SERVER_ONLY = /^(guests|invites|meta)\.json$/;
const BANK = /^(recipes|recipes-staging)\/([a-z0-9][a-z0-9-]*)\.json$/;
const OWN_TARGETS = /^profiles\/([a-z0-9][a-z0-9-]*)\/(?:profile|fitness)\/targets\.json$/;

/**
 * Where a path lives on Supabase.
 * @param {string} path
 * @returns {{ kind: "bank", id: string, staging: boolean }
 *   | { kind: "roster" }
 *   | { kind: "targets", owner: string }
 *   | { kind: "doc" }}
 */
export function classifyPath(path) {
  const bank = BANK.exec(path);
  if (bank) return { kind: "bank", id: String(bank[2]), staging: bank[1] === "recipes-staging" };
  if (path === "profiles.json") return { kind: "roster" };
  // root profile/targets.json is the root profile's; root fitness/targets.json
  // is not stored here at all (the GitHub lane keeps it for Anvil)
  if (path === "profile/targets.json") return { kind: "targets", owner: ROOT_PROFILE };
  const own = OWN_TARGETS.exec(path);
  if (own) return { kind: "targets", owner: String(own[1]) };
  return { kind: "doc" };
}

/**
 * The sha rule (item 9).
 * @param {{ rev: number, legacy_sha?: string | null }} row
 */
export function shaOf(row) {
  return row.rev === 1 ? (row.legacy_sha ?? "pg:1") : `pg:${row.rev}`;
}

/**
 * The fingerprint a frozen pot keys on (ENG L2-3): the plate's, the same on
 * every device. legacy_sha while the plate is at rev 1, else its content hash.
 * @param {PlateRow} plate
 */
export function plateShaOf(plate) {
  return plate.rev === 1 && plate.legacy_sha ? plate.legacy_sha : `plate:${plate.content_hash}`;
}

/**
 * Turn a Supabase error into the seam's typed failures.
 * @param {{ code?: string, message?: string, status?: number }} error
 * @param {string} path
 * @returns {Error}
 */
export function mapError(error, path) {
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "");
  if (code === "P0409") return new ConflictError(path);
  if (code === "P0422") return new NameGuardError(path);
  // P0403 is write_doc's uniform refusal; 42501 is a policy or grant saying
  // no; a path the database cannot place is refused the same way
  if (code === "P0403" || code === "42501" || /mise_bad_path/.test(msg)) {
    return new ForbiddenError(path);
  }
  if (error.status === 401 || /^PGRST30[0-9]$/.test(code) || /jwt/i.test(msg)) {
    return new AuthError(msg || "session rejected");
  }
  return new Error(`supabase ${path}: ${code} ${msg}`.trim());
}

/**
 * @param {{
 *   client: SupabaseLike,
 *   session: () => import("../backend.js").BackendSession | null,
 *   accessToken?: () => string | null,
 *   stamp?: string,
 * }} opts
 * @returns {import("../backend.js").Backend}
 */
export function createSupabaseAdapter({
  client,
  session,
  accessToken = () => null,
  stamp = "supabase",
}) {
  /**
   * @param {PromiseLike<SbResult>} q
   * @param {string} path
   */
  const run = async (q, path) => {
    const { data, error } = await q;
    if (error) throw mapError(error, path);
    return data;
  };

  /** @returns {import("../backend.js").BackendSession} */
  const asker = () => {
    const s = session();
    if (!s) throw new AuthError("not signed in");
    return s;
  };

  /**
   * @param {string} path
   * @returns {Promise<DocRow | null>}
   */
  const docRow = (path) =>
    run(client.from("docs").select("data,rev,legacy_sha").eq("path", path).maybeSingle(), path);

  /**
   * @param {string} id
   * @param {string} path
   * @returns {Promise<(DocRow & { staging: boolean }) | null>}
   */
  const bankRow = (id, path) =>
    run(
      client.from("recipes").select("data,rev,legacy_sha,staging").eq("id", id).maybeSingle(),
      path,
    );

  /**
   * The owner's plate. A plate is keyed by profile uuid, which the client
   * never sees, so it is asked for by slug (public.plate_for, db lane).
   * @param {string} owner
   * @param {string} path
   * @returns {Promise<PlateRow | null>}
   */
  const plateRow = async (owner, path) => {
    const got = await run(client.rpc("plate_for", { p_slug: owner }), path);
    const row = Array.isArray(got) ? got[0] : got;
    return row && typeof row === "object" ? /** @type {PlateRow} */ (row) : null;
  };

  /**
   * The row a path's sha is checked against, for the legacy mapping.
   * @param {string} path
   * @returns {Promise<{ legacy_sha?: string | null } | null>}
   */
  const legacyOf = async (path) => {
    const c = classifyPath(path);
    if (c.kind === "bank") return bankRow(c.id, path);
    if (c.kind === "roster") return null;
    return docRow(path);
  };

  /**
   * The rev write_doc should expect for a write carrying `sha`.
   * @param {string} path
   * @param {string | null | undefined} sha
   * @returns {Promise<number | null>}
   */
  const expectedRev = async (path, sha) => {
    if (!sha) return null;
    const pg = /^pg:(\d+)$/.exec(sha);
    if (pg) return Number(pg[1]);
    const row = await legacyOf(path);
    return row?.legacy_sha && row.legacy_sha === sha ? 1 : null;
  };

  /**
   * Where a phone path is stored on the server, or null for a file this
   * phone never reads or writes on Supabase.
   * @param {string} path
   * @returns {string | null}
   */
  const serverPath = (path) => {
    if (SERVER_ONLY.test(path)) return null;
    if (HOUSE_FILES.test(path)) {
      const home = asker().home;
      return home ? `households/${home}/${path}` : null;
    }
    return path;
  };

  /** @param {string} phonePath */
  async function read(phonePath) {
    const path = serverPath(phonePath);
    if (path === null) return null;
    const c = classifyPath(path);
    if (c.kind === "bank") {
      const row = await bankRow(c.id, path);
      if (!row || Boolean(row.staging) !== c.staging) return null;
      return { data: row.data, sha: shaOf(row) };
    }
    if (c.kind === "roster") {
      const got = await run(client.rpc("roster"), path);
      if (!got || !Array.isArray(got.profiles)) return null;
      return { data: { profiles: got.profiles.map(rosterEntry) }, sha: `pg:${got.rev}` };
    }
    if (c.kind === "targets") {
      const me = asker();
      if (!(me.admin || me.slug === c.owner)) {
        const plate = await plateRow(c.owner, path);
        if (!plate) return null;
        const sha = plateShaOf(plate);
        return { data: plate.data, sha, fingerprint: sha };
      }
    }
    const row = await docRow(path);
    if (!row) return null;
    if (c.kind === "targets") {
      // the owner's own fingerprint is the plate's too (ENG L2-3), so every
      // device that froze a pot on these targets compares the same value
      const plate = await plateRow(c.owner, path);
      return { data: row.data, sha: shaOf(row), fingerprint: plate ? plateShaOf(plate) : null };
    }
    return { data: row.data, sha: shaOf(row) };
  }

  return {
    name: "supabase",
    read,
    async write(phonePath, data, sha) {
      const path = serverPath(phonePath);
      if (path === null) throw new ForbiddenError(phonePath);
      const expected = await expectedRev(path, sha);
      const rev = await run(
        client.rpc("write_doc", { p_path: path, p_data: data, p_expected_rev: expected }),
        path,
      );
      if (typeof rev !== "number" && typeof rev !== "string") {
        throw new Error(`supabase ${path}: write_doc returned no rev`);
      }
      return { sha: `pg:${Number(rev)}` };
    },
    async list(dir) {
      const bank = /^(recipes|recipes-staging)$/.exec(dir);
      if (bank) {
        /** @type {(DocRow & { id: string })[]} */
        const rows =
          (await run(
            client
              .from("recipes")
              .select("id,data,rev,legacy_sha")
              .eq("staging", bank[1] === "recipes-staging"),
            dir,
          )) ?? [];
        return rows.map((r) => ({
          name: `${r.id}.json`,
          path: `${dir}/${r.id}.json`,
          sha: shaOf(r),
          data: r.data,
        }));
      }
      const pattern = `${dir.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`;
      /** @type {(DocRow & { path: string })[]} */
      const rows =
        (await run(
          client.from("docs").select("path,data,rev,legacy_sha").like("path", pattern),
          dir,
        )) ?? [];
      const prefix = `${dir}/`;
      // the Contents API lists one level of JSON files; so does this
      return rows
        .filter((r) => {
          const rest = r.path.slice(prefix.length);
          return r.path.startsWith(prefix) && !rest.includes("/") && rest.endsWith(".json");
        })
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((r) => ({
          name: r.path.slice(prefix.length),
          path: r.path,
          sha: shaOf(r),
          data: r.data,
        }));
    },
    async readMeta(path) {
      const got = await read(path);
      return got ? { sha: got.fingerprint ?? got.sha } : null;
    },
    async authHeader() {
      const token = accessToken();
      return token ? `Bearer ${token}` : null;
    },
    async status() {
      if (!session()) return { privacy: "private", auth: "missing", reachable: true };
      try {
        const { error } = await client.rpc("roster");
        if (!error) return { privacy: "private", auth: "ok", reachable: true };
        return mapError(error, "roster") instanceof AuthError
          ? { privacy: "private", auth: "invalid", reachable: true }
          : { privacy: "private", auth: "unknown", reachable: true };
      } catch {
        return { privacy: "private", auth: "unknown", reachable: false };
      }
    },
    authBroken: (status) => status === "invalid",
    stamp: () => stamp,
    laneOf: () => "supabase",
    session,
  };
}

/**
 * One roster() row as a 1.95 profiles.json entry: the stored roster fields,
 * then the server's own id, house, family and admin flag over them, each
 * only when the server gave it (roster() nulls what this caller may not see).
 * @param {Record<string, any>} row
 * @returns {Record<string, unknown>}
 */
function rosterEntry(row) {
  /** @type {Record<string, unknown>} */
  const out = { ...(row.roster && typeof row.roster === "object" ? row.roster : {}), id: row.id };
  for (const k of ["household", "family"]) {
    if (row[k] != null) out[k] = row[k];
    else delete out[k];
  }
  if (row.admin === true) out.admin = true;
  else delete out.admin;
  return out;
}
