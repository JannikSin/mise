// WHO COOKS THIS, on the plan row (David 2026-09-13: "should be more clear
// about who cooks each meal").
import test from "node:test";
import assert from "node:assert/strict";
import { cookLine } from "../app/lib/plan.js";

const day = (iso) => ({ "2026-09-07": "Mon", "2026-09-08": "Tue" })[iso] ?? iso;

test("a shared cook night names the cook, 'you' on the cook's own device", () => {
  const e = { table: "t1", cookId: "david", cookName: "David" };
  assert.equal(cookLine(e, "david", day), "🍳 you cook");
  assert.equal(cookLine(e, "elliot", day), "🍳 David cooks");
});

test("a leftover night names the pot's day and who cooked it", () => {
  const e = {
    table: "t2",
    cookId: "david",
    cookName: "David",
    leftoverOf: "b-wayne-kitchen-2026-09-07-dinner",
    leftoverDate: "2026-09-07",
  };
  assert.equal(cookLine(e, "elliot", day), "♻ leftovers of Mon, David cooked it");
  assert.equal(cookLine(e, "david", day), "♻ leftovers of Mon, you cooked it");
  // a solo plan stamps the cook DATE itself
  assert.equal(cookLine({ leftoverOf: "2026-09-07" }, "david", day), "♻ leftovers of Mon");
});

test("a per-portion shared dish says everyone makes their own; a plain solo meal says nothing", () => {
  assert.equal(
    cookLine({ table: "t3", cookId: "david", cookName: "David" }, "elliot", day, true),
    "🥣 each makes their own",
  );
  assert.equal(cookLine({ recipeId: "x", servings: 1 }, "david", day), "");
  // the old cook-device-only signal still reads as "you cook" when nothing better is known
  assert.equal(cookLine({ table: "t4", cookTotal: 2 }, "david", day), "🍳 you cook");
});

test("the Sunday batch reads on every row it touches", () => {
  const dn = (iso) => ({ "2026-09-27": "Sun", "2026-09-29": "Tue" })[iso] ?? iso;
  assert.equal(
    cookLine({ table: "t", cookId: "david", preparedOn: "2026-09-27" }, "david", dn),
    "🥘 Sun batch, reheat, you cooked it",
  );
  assert.equal(
    cookLine(
      {
        table: "t",
        cookId: "david",
        cookName: "David",
        leftoverOf: "x",
        leftoverDate: "2026-09-29",
        leftoverPrepared: "2026-09-27",
      },
      "elliot",
      dn,
    ),
    "🥘 Sun batch, reheat, David cooked it",
  );
  assert.equal(
    cookLine(
      { table: "t", cookId: "david", batchAlongside: { name: "Chili", date: "2026-09-29" } },
      "david",
      dn,
    ),
    "🍳 you cook · plus the batch for Tue: Chili",
  );
});
