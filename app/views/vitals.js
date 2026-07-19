import { html } from "htm/preact";
import { latestWith, series, average, sparkPoints, latestEkg } from "../lib/vitals.js";

/**
 * Vitals dashboard: read-only Apple Watch / Apple Health metrics. Populated
 * by an Apple Shortcuts automation that posts HealthKit data to
 * profiles/<id>/health/vitals.json (a PWA cannot read HealthKit itself), so
 * an empty file is the normal pre-connection state, not an error.
 *
 * Six metric tiles (latest value + a 14-day sparkline where a trend helps)
 * plus the most recent EKG. Every metric is optional: a watch that never
 * posts HRV simply hides that tile.
 * @param {{ vitals: import("../lib/vitals.js").Vitals | null, loading: boolean, hasToken: boolean }} props
 * @returns {import("preact").VNode}
 */
export function VitalsView({ vitals, loading, hasToken }) {
  const days = vitals?.days ?? [];
  const ekg = latestEkg(vitals?.ekg ?? []);

  /**
   * @param {string} label
   * @param {keyof import("../lib/vitals.js").VitalsDay} field
   * @param {string} unit
   * @param {(v: number) => string} fmt
   * @param {boolean} spark
   */
  const tile = (label, field, unit, fmt, spark) => {
    const latest = latestWith(days, field);
    if (!latest) return null;
    const pts = spark ? series(days, field, 14) : [];
    const avg = pts.length > 2 ? average(pts, field === "distanceMi" || field === "hrvMs" ? 1 : 0) : null;
    const poly = sparkPoints(pts, 120, 32);
    return html`
      <div class="tile vital" key=${field}>
        <div class="k">${label}</div>
        <div class="v num">${fmt(latest.value)} <span class="unit">${unit}</span></div>
        ${
          poly &&
          html`<svg class="vital-spark" viewBox="0 0 120 32" width="120" height="32" aria-hidden="true">
            <polyline points=${poly} fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>`
        }
        ${avg !== null && html`<div class="d hint">14-day avg ${fmt(avg)} ${unit}</div>`}
        <div class="d hint">as of ${latest.date}</div>
      </div>
    `;
  };

  const tiles = [
    tile("Steps", "steps", "", (v) => v.toLocaleString("en-US"), true),
    tile("Distance", "distanceMi", "mi", (v) => v.toFixed(1), true),
    tile("Active energy", "activeKcal", "kcal", (v) => Math.round(v).toLocaleString("en-US"), true),
    tile("Resting HR", "restingHR", "bpm", (v) => String(Math.round(v)), true),
    tile("HRV", "hrvMs", "ms", (v) => v.toFixed(0), true),
    tile("Sleep", "sleepHours", "h", (v) => v.toFixed(1), true),
    tile("VO₂ max", "vo2max", "", (v) => v.toFixed(1), false),
  ].filter(Boolean);

  return html`
    <div class="view">
      <div class="hero"><h1>Vitals</h1></div>
      ${loading && html`<p class="hint">loading…</p>`}
      ${
        !loading &&
        tiles.length === 0 &&
        html`<div class="empty">
          ${
            hasToken
              ? "no watch data yet — connect the Apple Shortcuts automation that posts to health/vitals.json (see docs)"
              : "connect token in SYS"
          }
        </div>`
      }
      ${tiles.length > 0 && html`<div class="vital-grid">${tiles}</div>`}
      ${
        ekg &&
        html`
          <div class="tile">
            <div class="k">Latest EKG</div>
            <div class="v">${ekg.result}${ekg.avgBpm ? html` · <span class="num">${ekg.avgBpm}</span> bpm` : ""}</div>
            <div class="d hint">${ekg.date}</div>
          </div>
        `
      }
      <p class="hint">
        Read-only mirror of Apple Health. Updated by the phone automation, not editable here.
      </p>
    </div>
  `;
}
