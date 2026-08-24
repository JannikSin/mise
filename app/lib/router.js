// Hash router (zero-build, Pages-subpath-safe).

/**
 * @param {string} hash
 * @returns {{ view: string, id?: string, from?: string, servings?: number, entry?: string, table?: string }}
 */
export function parseRoute(hash) {
  // optional ?from=<origin> query (e.g. #/recipe/x?from=today) tells the
  // recipe views which tab opened them so the backlink returns there
  const [path = "", query] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const [head, id] = parts;
  switch (head) {
    // #/ and #/today are permanent ALIASES for the merged Plan tab, not
    // redirects. Plan absorbed Cook and Home retired, but the Worker pushes
    // ntfy notifications deep-linking to #/today (worker/src/lib.js), and the
    // family have bookmarks. Aliasing means the URL keeps working forever
    // with zero Worker changes.
    case undefined:
    case "today":
    case "home":
      return { view: "plan" };
    case "cookbook":
    case "annotate":
    case "system":
    case "plan":
    case "list":
    case "remedies":
    case "menu":
    case "dinner":
    case "ask":
    case "occasions":
    case "tables":
      return { view: head };
    // the hall screen is opened FROM a swipe slot, which already knows the
    // date and the meal; carrying them in the hash means it never asks twice
    case "hall": {
      const params = new URLSearchParams(query);
      /** @type {{ view: string, date?: string, meal?: string }} */
      const route = { view: "hall" };
      const d = params.get("date");
      const m = params.get("meal");
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) route.date = d;
      if (m) route.meal = m;
      return route;
    }
    case "recipe": {
      if (!id) return { view: "plan" };
      let decoded;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return { view: "plan" }; // malformed percent-sequence in the hash
      }
      /** @type {{ view: string, id: string, from?: string, servings?: number, entry?: string, table?: string }} */
      // Cook Mode is GONE (David 2026-08-17 "get rid of that entirely",
      // executed 2026-08-19 with the serve step rehomed to the recipe page):
      // old /cook URLs land on the recipe, params intact
      const route = { view: "recipe", id: decoded };
      const params = new URLSearchParams(query);
      const from = params.get("from");
      if (from) route.from = from;
      const servings = Number(params.get("servings"));
      if (servings > 0) route.servings = servings;
      // ?entry=<plan entry id> lets the cook timer's END button confirm THAT
      // planned meal as cooked (the honest-eaten rule)
      const entry = params.get("entry");
      if (entry) route.entry = entry;
      // ?table=<table id> is the table-meal equivalent: the recipe page's
      // serve tile carries who-gets-what and COOKED confirms the TABLE
      const table = params.get("table");
      if (table) route.table = table;
      return route;
    }
    default:
      return { view: "plan" };
  }
}

/**
 * Subscribe to route changes; fires immediately with the current route.
 * @param {(route: { view: string, id?: string, from?: string, servings?: number, entry?: string }) => void} onChange
 */
export function initRouter(onChange) {
  const fire = () => onChange(parseRoute(location.hash));
  window.addEventListener("hashchange", fire);
  fire();
}
