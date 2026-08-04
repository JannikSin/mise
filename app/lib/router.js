// Hash router (zero-build, Pages-subpath-safe).

/**
 * @param {string} hash
 * @returns {{ view: string, id?: string, from?: string, servings?: number, entry?: string }}
 */
export function parseRoute(hash) {
  // optional ?from=<origin> query (e.g. #/recipe/x?from=today) tells the
  // recipe views which tab opened them so the backlink returns there
  const [path = "", query] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const [head, id, sub] = parts;
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
    case "system":
    case "plan":
    case "list":
    case "train":
    case "remedies":
    case "vitals":
    case "menu":
    case "dinner":
    case "ask":
    case "tables":
      return { view: head };
    case "recipe": {
      if (!id) return { view: "plan" };
      let decoded;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return { view: "plan" }; // malformed percent-sequence in the hash
      }
      /** @type {{ view: string, id: string, from?: string, servings?: number, entry?: string }} */
      const route = { view: sub === "cook" ? "cook" : "recipe", id: decoded };
      const params = new URLSearchParams(query);
      const from = params.get("from");
      if (from) route.from = from;
      const servings = Number(params.get("servings"));
      if (servings > 0) route.servings = servings;
      // ?entry=<plan entry id> lets Cook mode's DONE button confirm THAT
      // planned meal as cooked (the honest-eaten rule)
      const entry = params.get("entry");
      if (entry) route.entry = entry;
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
