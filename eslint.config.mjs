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
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
