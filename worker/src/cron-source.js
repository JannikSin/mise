// Mise 2.0 F2: where the hourly notification cron reads from. One interface,
// two sources: GitHub (1.95, the data repo with a read-only PAT) and Supabase
// (svc.cron_inputs and svc.recipe_names, supa-routes.js). runNotifications in
// index.js is the same code for both, so a ping cannot behave differently
// after the switch.

/**
 * @typedef {{
 *   read(weekId: string, wantsShopping: boolean): Promise<{
 *     me: string,
 *     house: string,
 *     plan: Record<string, any> | null,
 *     events: Record<string, any> | null,
 *     shopping: Record<string, any> | null,
 *   }>,
 *   names(house: string, ids: string[]): Promise<Record<string, string>>,
 * }} CronSource
 */

/**
 * The 1.95 source: exactly the reads the cron always made.
 * @param {(path: string) => Promise<Record<string, any> | null>} readJson
 * @returns {CronSource}
 */
export function githubCronSource(readJson) {
  const me = "david";
  return {
    async read(weekId, wantsShopping) {
      const plan = await readJson(`plans/${weekId}.json`);
      const profiles = await readJson("profiles.json");
      const house = String(
        (profiles?.profiles ?? []).find((/** @type {any} */ p) => p?.id === me)?.household ?? "",
      );
      const events = /^[a-z0-9-]+$/.test(house)
        ? await readJson(`households/${house}/events.json`)
        : null;
      const shopping = wantsShopping ? await readJson("shopping.json") : null;
      return { me, house, plan, events, shopping };
    },
    async names(_house, ids) {
      /** @type {Record<string, string>} */
      const out = {};
      for (const id of ids) {
        const r = await readJson(`recipes/${id}.json`);
        if (r?.name) out[id] = String(r.name);
      }
      return out;
    },
  };
}
