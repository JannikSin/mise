// Hash router (zero-build, Pages-subpath-safe).

/**
 * @param {string} hash
 * @returns {{ view: string, id?: string, from?: string, servings?: number }}
 */
export function parseRoute(hash) {
  // optional ?from=<origin> query (e.g. #/recipe/x?from=today) tells the
  // recipe views which tab opened them so the backlink returns there
  const [path = "", query] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const [head, id, sub] = parts;
  switch (head) {
    case undefined:
      return { view: "home" };
    case "cookbook":
    case "today":
    case "system":
    case "plan":
    case "list":
    case "train":
    case "remedies":
    case "vitals":
    case "menu":
    case "dinner":
    case "tables":
      return { view: head };
    case "recipe": {
      if (!id) return { view: "home" };
      let decoded;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return { view: "home" }; // malformed percent-sequence in the hash
      }
      /** @type {{ view: string, id: string, from?: string, servings?: number }} */
      const route = { view: sub === "cook" ? "cook" : "recipe", id: decoded };
      const params = new URLSearchParams(query);
      const from = params.get("from");
      if (from) route.from = from;
      const servings = Number(params.get("servings"));
      if (servings > 0) route.servings = servings;
      return route;
    }
    default:
      return { view: "home" };
  }
}

/**
 * Subscribe to route changes; fires immediately with the current route.
 * @param {(route: { view: string, id?: string, from?: string, servings?: number }) => void} onChange
 */
export function initRouter(onChange) {
  const fire = () => onChange(parseRoute(location.hash));
  window.addEventListener("hashchange", fire);
  fire();
}
