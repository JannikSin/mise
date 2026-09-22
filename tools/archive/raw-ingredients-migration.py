# One-shot migration (David, 2026-08-18 late): recipes never list a PREPPED
# product as an ingredient. "cooked brown rice" is brown rice you cooked on
# Sunday; the shopping list must buy the raw thing, and the recipe's first
# step declares the batch prep. Converts 28 ingredient rows across the bank
# (+ Mom's copies), deletes the "cooked chicken" pantry state row (a prep
# state is not a purchasable SKU), drops the wrong whey pin (Costco bulk,
# never a store row), and records David's weekly budget number.
import json, glob, io, os

DATA = os.path.join(os.path.dirname(__file__), "..", "..", "mise-data")

# raw-form conversions: rice trebles when cooked; chicken loses ~30% weight
def convert(food, qty, unit):
    f = food.lower()
    if f in ("cooked brown rice", "cooked white rice"):
        raw = "brown rice" if "brown" in f else "white rice"
        if unit == "g":
            dry = round(qty / 3 / 5) * 5
            return raw, dry, unit, f"{int(qty)} g"
        dry = round(qty / 3, 2)
        return raw, dry, unit, f"{qty:g} {unit}"
    if f == "cooked chicken":
        if unit == "g":
            rawq = round(qty / 0.7 / 5) * 5
            return "chicken breast", rawq, unit, f"{int(qty)} g"
        return "chicken breast", qty, unit, f"{qty:g} {unit}"
    return None

def migrate(path):
    with io.open(path, encoding="utf-8") as fh:
        r = json.load(fh)
    prepped = []
    changed = False
    for ing in r.get("ingredients", []):
        c = convert(str(ing.get("food", "")), ing.get("qty"), str(ing.get("unit", "")))
        if not c:
            continue
        raw, rawq, unit, cooked_desc = c
        old_note = str(ing.get("note", ""))
        ing["food"] = raw
        ing["qty"] = rawq
        ing["note"] = f"raw; cooks to ~{cooked_desc} (Sunday batch)"
        prepped.append((raw, rawq, unit, cooked_desc, old_note))
        changed = True
    if not changed:
        return False
    parts = [
        f"{q:g} {u} {name} (cooks to ~{cooked})" for name, q, u, cooked, _ in prepped
    ]
    text = (
        "Batch prep, usually already done Sunday - skip if it is: cook "
        + "; ".join(parts)
        + ". The amounts below the line are the RAW buy; the steps use the cooked yield."
    )
    steps = r.get("instructions", [])
    steps.insert(0, {"step": 0, "text": text})
    for i, s in enumerate(steps):
        s["step"] = i + 1
    r["instructions"] = steps
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(r, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return True

n = 0
for path in glob.glob(os.path.join(DATA, "recipes", "*.json")) + glob.glob(
    os.path.join(DATA, "profiles", "*", "recipes", "*.json")
):
    if migrate(path):
        n += 1
        print("migrated", os.path.relpath(path, DATA))
print(f"{n} recipes migrated")

# pantry: the cooked-chicken state row leaves (chicken breast already exists)
ppath = os.path.join(DATA, "households", "taranowski", "pantry.json")
with io.open(ppath, encoding="utf-8") as fh:
    pantry = json.load(fh)
before = len(pantry.get("items", []))
pantry["items"] = [i for i in pantry["items"] if i.get("id") != "cooked-chicken"]
# keep the derived mirrors coherent with the items edit
if "staples" in pantry:
    pantry["staples"] = [s for s in pantry["staples"] if str(s.get("name", s.get("food", ""))).lower() != "cooked chicken"]
with io.open(ppath, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(pantry, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("pantry cooked-chicken rows removed:", before - len(pantry["items"]))

# pins: whey is Costco bulk, never a store row (David, 2026-08-18)
pinpath = os.path.join(DATA, "pins.json")
with io.open(pinpath, encoding="utf-8") as fh:
    pins = json.load(fh)
dropped = pins["pins"].pop("whey-protein-powder", None)
with io.open(pinpath, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(pins, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("whey pin dropped:", bool(dropped))

# David's weekly budget number (display-only line, P5): ~$120-130 solo
tpath = os.path.join(DATA, "fitness", "targets.json")
with io.open(tpath, encoding="utf-8") as fh:
    targets = json.load(fh)
targets["weeklyBudgetUsd"] = 125
with io.open(tpath, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(targets, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("weeklyBudgetUsd set: 125")
