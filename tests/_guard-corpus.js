// The name guard corpus (not a test file): every F1 string of the Red Team
// report and near misses, shared by tests/name-guard.test.js and
// tests/db-fix1.test.js. Made-up words only.
import { guardPath } from "../tools/name-guard.mjs";

/** Every F1 string from the Red Team report, and more of the same shape. Each must hit "kinword". */
export const HITS = /** @type {[string, unknown, string | null][]} */ ([
  ["plain", { note: "kinword" }, null],
  ["after a newline", { note: "\nkinword" }, null],
  ["after a tab", { note: "\tkinword" }, null],
  ["plural", { note: "kinwords" }, null],
  ["plural es", { note: "kinwordes" }, null],
  ["digit", { note: "kinword2" }, null],
  ["Cyrillic i", { note: "k\u0456nword" }, null],
  ["Cyrillic o and upper case", { note: "KINW\u041eRD" }, null],
  ["Greek omicron", { note: "kinw\u03bfrd" }, null],
  ["zero-width space", { note: "kin\u200bword" }, null],
  ["soft hyphen", { note: "kin\u00adword" }, null],
  ["accent", { note: "k\u00ednword" }, null],
  ["fullwidth", { note: "\uff4b\uff49\uff4e\uff57\uff4f\uff52\uff44" }, null],
  ["split across an array", { note: ["kin", "word"] }, null],
  ["bank name after a newline", { id: "x", name: "Soup\nKinword" }, null],
  ["recipe step", { steps: ["Brown the beans.\nKinword likes it hot."] }, null],
  ["plural possessive", { note: "the Kinwords' favourite" }, null],
  ["possessive", { note: "Kinword's soup" }, null],
  ["curly possessive", { note: "Kinword\u2019s soup" }, null],
  ["object key", { kinword: true }, null],
  ["path", { id: "x" }, guardPath("profiles/mate-1/recipes/kinword-lasagna.json")],
]);

/** Must NOT hit "kinword". */
export const MISSES = /** @type {[string, unknown, string | null][]} */ ([
  ["another word", { note: "kinship words" }, null],
  ["inside a word", { note: "skinwordy" }, null],
  ["two words", { note: "kin word" }, null],
  ["chamomile", { note: "Chamomile and cardamom" }, null],
  ["owner segment is not text", { id: "x" }, guardPath("profiles/kinword/recipes/soup.json")],
]);

