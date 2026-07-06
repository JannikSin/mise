#!/usr/bin/env node
/**
 * Mise PreToolUse hook: hard-block edits to secret files and vendored libs.
 * Exit 2 blocks the tool call; stderr explains why to the model.
 */
import { readFileSync } from "node:fs";
import { resolve, relative, basename } from "node:path";

let input = null;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path;
if (!filePath) process.exit(0);

const rel = relative(process.cwd(), resolve(filePath)).replaceAll("\\", "/");
const name = basename(rel);

const SECRET = /^\.env(\..*)?$/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
const VENDORED = /^vendor\//.test(rel);

if (SECRET) {
  process.stderr.write(
    `BLOCKED: ${rel} is a secret-material path. Mise rule (CLAUDE.md Part 2, ` +
      `rule 7): secrets live only in browser localStorage or Worker env - ` +
      `never in files. There is no legitimate reason to create or edit this file.`
  );
  process.exit(2);
}

if (VENDORED) {
  process.stderr.write(
    `BLOCKED: ${rel} is a vendored, version-pinned library. Vendored libs are ` +
      `never patched in place - they are replaced wholesale with a new pinned ` +
      `version, with David's approval. If the library seems to have a bug, ` +
      `re-check the calling code first.`
  );
  process.exit(2);
}

process.exit(0);
