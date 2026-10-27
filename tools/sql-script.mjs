// Mise 2.0 G2: small helpers for the operator tools that write a SQL script
// for David to run (add-member, delete-member, make-probe). Those tools never
// connect to a database: they write one reviewable transaction, which David
// runs with psql (or pastes into the SQL Editor), and the PGlite tests run the
// same text. Every value is validated by the tool before it reaches here.

/** A SQL string literal (standard_conforming_strings, the Postgres default). @param {string} s */
export function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** A jsonb literal. @param {unknown} v */
export function jsonLit(v) {
  return `${lit(JSON.stringify(v))}::jsonb`;
}

/** A text[] literal. @param {string[]} xs */
export function textArray(xs) {
  return `array[${xs.map(lit).join(", ")}]::text[]`;
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const EMAIL = /^[^@\s'"\\]+@[^@\s'"\\]+\.[^@\s'"\\]+$/;

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = String(argv[i]);
    if (!k.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      a[k.slice(2)] = next;
      i++;
    } else a[k.slice(2)] = true;
  }
  return a;
}
