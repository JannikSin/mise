// The waste ledger (PF.1, 2026-08-18). Canon: P6's dormancy rule ("what
// expired in your absence is written off as an explicit ledger event, never
// silently deleted — dormancy must not launder waste past the ledger") and
// P11's tossed-vs-used review axis. Every food row that leaves the pantry
// WITHOUT being cooked lands here, because unlike every other measurement in
// the app this history cannot be backfilled: a week with no waste ledger is
// a week of ground truth gone. Household-scoped, sibling file to
// pantry.json (households/<h>/waste.json). Shape: { events: [...] }.

/**
 * One waste event per tossed row: what it was, when it was written off, and
 * why. `reason` today is always "expired" (the auto-expiry sweep); a manual
 * confirm and the P11 review add their own reasons when they land.
 * @param {Record<string, any> | null | undefined} existing waste.json as read
 * @param {Record<string, any>[]} rows the pantry rows being written off
 * @param {string} todayIso
 * @param {string} [reason]
 * @returns {{ events: Record<string, any>[] }}
 */
export function appendWaste(existing, rows, todayIso, reason = "expired") {
  const events = Array.isArray(existing?.events) ? existing.events.slice() : [];
  // `id` is UNIQUE PER EVENT (row + date + reason), never the bare pantry-row
  // id: the 409 keyed-array merge collapses same-id elements, and a row that
  // gets resurrected by an edit-beats-delete merge can legitimately expire
  // twice on different dates — two events, two ids (reviewer finding 1). The
  // same key doubles as the idempotency check: every device in the house
  // runs the same expiry sweep, one write-off each.
  const seen = new Set(events.map((/** @type {any} */ e) => e.id));
  for (const r of rows) {
    const rowId = r.id ?? null;
    const id = `${rowId ?? `f:${String(r.food ?? "")}|${r.added ?? ""}`}|${todayIso}|${reason}`;
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({
      id,
      date: todayIso,
      reason,
      rowId,
      food: String(r.food ?? ""),
      ...(r.qty != null && r.qty !== "" ? { qty: r.qty } : {}),
      ...(r.added ? { added: r.added } : {}),
      ...(r.location ? { location: r.location } : {}),
    });
  }
  return { events };
}

/**
 * The review's tossed-vs-used input: events inside [fromIso, toIso].
 * @param {Record<string, any> | null | undefined} waste
 * @param {string} fromIso inclusive
 * @param {string} toIso inclusive
 * @returns {Record<string, any>[]}
 */
export function wasteBetween(waste, fromIso, toIso) {
  return (Array.isArray(waste?.events) ? waste.events : []).filter(
    (/** @type {any} */ e) => typeof e.date === "string" && e.date >= fromIso && e.date <= toIso,
  );
}
