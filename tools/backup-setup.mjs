#!/usr/bin/env node
// Mise 2.0 G2: David's step 10, the backup role's password and connection
// string, so nothing is typed by hand and no placeholder is ever pasted.
//
//   node tools/backup-setup.mjs role-sql --ref <project ref> --pooler-host <host from Connect, Session pooler>
//
// Prints two lines and touches nothing (no network, no file):
//   1. the one SQL statement to paste into that project's SQL Editor, with a
//      fresh random password (it turns on login for the read-only role);
//   2. the connection string to paste as the Actions secret
//      (MISE_BACKUP_DB_URL for live, MISE_SANDBOX_DB_URL for the sandbox).
// The password is shown once, here, and lives afterwards only in Supabase and
// the GitHub secret. Run it again to rotate.
//
// The session pooler is used because GitHub's runners have no IPv6, and the
// direct database host of a Free project is IPv6 only.
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @param {{ ref: string, poolerHost: string, password?: string }} o
 * @returns {{ sql: string, url: string }}
 */
export function roleSetup({ ref, poolerHost, password = randomBytes(24).toString("base64url") }) {
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error("--ref must be the 20-character project ref (the part before .supabase.co)");
  if (!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(poolerHost)) throw new Error("--pooler-host must be the Session pooler host, ending in .pooler.supabase.com");
  if (!/^[A-Za-z0-9_-]{24,}$/.test(password)) throw new Error("the password must be URL-safe");
  return {
    sql: `alter role mise_backup with login password '${password}';`,
    url: `postgresql://mise_backup.${ref}:${password}@${poolerHost}:5432/postgres?sslmode=require`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const val = (/** @type {string} */ k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args[0] !== "role-sql" || !val("--ref") || !val("--pooler-host")) {
    console.log("usage: node tools/backup-setup.mjs role-sql --ref <project ref> --pooler-host <session pooler host>");
    process.exit(2);
  }
  const r = roleSetup({ ref: String(val("--ref")), poolerHost: String(val("--pooler-host")) });
  console.log("1. Paste into this project's SQL Editor, then Run:");
  console.log(`   ${r.sql}`);
  console.log("2. Paste as the Actions secret in the private mise-backup repo:");
  console.log(`   ${r.url}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  }
}
