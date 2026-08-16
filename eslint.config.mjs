import js from "@eslint/js";

// Browser globals listed by hand — deliberately no `globals` package
// (CLAUDE.md Part 2, rule 5). Add here as the app starts using them.
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  fetch: "readonly",
  console: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  indexedDB: "readonly",
  caches: "readonly",
  crypto: "readonly",
  atob: "readonly",
  btoa: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  DOMException: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  File: "readonly",
  FileReader: "readonly",
  createImageBitmap: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  innerHeight: "readonly",
  innerWidth: "readonly",
  scrollBy: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  Uint8Array: "readonly",
  CustomEvent: "readonly",
  Event: "readonly",
  EventTarget: "readonly",
  MutationObserver: "readonly",
  IntersectionObserver: "readonly",
  ResizeObserver: "readonly",
  performance: "readonly",
  self: "readonly",
};

export default [
  {
    ignores: [
      "node_modules/",
      "vendor/",
      "mockups/",
      "spike/",
      ".claude/",
      "claude-config/",
      // template fragments for Playwright-MCP runs — `page`/`events` come
      // from a wrapper added at compose time (tests/e2e/README.md)
      "tests/e2e/",
      ".playwright-mcp/",
      // the cross-app suggest button: a deliberately dependency-free ES5
      // drop-in shared verbatim across all seven PWAs — restyling it here
      // would fork it from the copies in the other repos
      "suggest.js",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // TDZ guard. 2026-07-26: a useMemo added ABOVE `const me` referenced it,
      // which typechecks, lints clean under the defaults, and passes every
      // test — then throws "Cannot access 'me' before initialization" and
      // kills the whole app, but ONLY on a device where the branch holding the
      // reference actually runs. It never fired once on a machine with no
      // household profiles loaded. Functions stay hoistable (the file is full
      // of handlers defined after use); variables and classes must not be.
      "no-use-before-define": [
        "error",
        { functions: false, variables: true, classes: true, allowNamedExports: true },
      ],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // dev-only node scripts (git hooks, installers) — node globals, not browser
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
];
