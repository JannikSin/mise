// Hash router (zero-build, Pages-subpath-safe).

/**
 * @param {string} hash
 * @returns {{ view: string, id?: string }}
 */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [head, id, sub] = parts;
  switch (head) {
    case undefined:
      return { view: "home" };
    case "cookbook":
    case "quiz":
    case "system":
    case "plan":
    case "list":
      return { view: head };
    case "recipe": {
      if (!id) return { view: "home" };
      let decoded;
      try {
        decoded = decodeURIComponent(id);
      } catch {
        return { view: "home" }; // malformed percent-sequence in the hash
      }
      return sub === "cook" ? { view: "cook", id: decoded } : { view: "recipe", id: decoded };
    }
    default:
      return { view: "home" };
  }
}

/**
 * Subscribe to route changes; fires immediately with the current route.
 * @param {(route: { view: string, id?: string }) => void} onChange
 */
export function initRouter(onChange) {
  const fire = () => onChange(parseRoute(location.hash));
  window.addEventListener("hashchange", fire);
  fire();
}
