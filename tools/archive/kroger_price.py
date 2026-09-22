# Matcher v2. Fixes from the v1 run, in order of damage done:
#   1. HARD category denylist  -> kills baby powder for cornstarch, bath salts for almond butter
#   2. section -> allowed categories -> kills Nesquik for cocoa powder, ice cream for walnuts
#   3. every word of the food must appear (space-insensitive) -> "corn starch" == "cornstarch"
#   4. strip prep words from the search term -> "cooked brown rice" -> "brown rice"
#   5. MINIMISE ACTUAL SPEND, not unit price. One rule fixes the wine box, the 32oz nuts
#      and the 8lb chicken bag: cost = ceil(need/pack) * price, pick the cheapest TOTAL.
#   6. real unit table. tsp/tbsp/pinch = a spoonful. cup is a real volume. each is a piece.
#   7. produce sold `each` prefers a LOOSE item and uses a typical-weight table.
import re, json, io, math, base64, urllib.request, urllib.parse, urllib.error, time

PDF  = r"C:\Users\DATar\Downloads\App Registration Details _ Kroger Developers.pdf"
LOC  = "53100502"
LIST = r"C:\Users\DATar\Projects\mise-data\shopping.json"

import pdfplumber
t = "".join((p.extract_text() or "") + "\n" for p in pdfplumber.open(PDF).pages)
cid = csec = None
for l in (x.strip() for x in t.splitlines()):
    m = re.match(r"^client_id\s+(\S+)$", l, re.I)
    cid = m.group(1) if m else cid
    m = re.match(r"^client_secret\s+(\S+)$", l, re.I)
    csec = m.group(1) if m else csec

b = urllib.parse.urlencode({"grant_type": "client_credentials", "scope": "product.compact"}).encode()
rq = urllib.request.Request(
    "https://api.kroger.com/v1/connect/oauth2/token", data=b,
    headers={"Content-Type": "application/x-www-form-urlencoded",
             "Authorization": "Basic " + base64.b64encode(f"{cid}:{csec}".encode()).decode()})
TOK = json.load(urllib.request.urlopen(rq))["access_token"]


def search(term, limit=30):
    q = urllib.parse.urlencode({"filter.term": term, "filter.locationId": LOC, "filter.limit": limit})
    r = urllib.request.Request("https://api.kroger.com/v1/products?" + q,
                               headers={"Authorization": "Bearer " + TOK, "Accept": "application/json"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(r, timeout=30) as f:
                return json.load(f).get("data", [])
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503):
                time.sleep(1.5)
                continue
            return []
        except Exception:
            time.sleep(1)
    return []


CAT_DENY = {"baby", "personal care", "beauty", "health", "household", "pet", "cleaning",
            "paper", "home", "office", "floral", "garden", "apparel", "toys", "electronics",
            "hardware", "automotive", "tobacco"}

CAT_OK = {
    "produce":    {"produce", "natural & organic", "snacks"},
    "meat":       {"meat", "seafood", "poultry"},
    "dairy":      {"dairy", "deli", "natural & organic", "eggs"},
    "bakery":     {"bakery", "bread"},
    "baking":     {"baking goods", "natural & organic"},
    "spices":     {"baking goods", "condiment & sauces", "natural & organic", "international"},
    "canned":     {"canned & packaged", "pantry", "natural & organic", "international", "soup"},
    "condiments": {"condiment & sauces", "international", "natural & organic", "pantry"},
    "grains":     {"pasta, sauces, grain", "breakfast", "baking goods", "natural & organic",
                   "canned & packaged", "pantry"},
    "frozen":     {"frozen"},
    "beverages":  {"beverages", "adult beverage", "natural & organic"},
    "other":      set(),  # any food category
}

PREP = r"\b(cooked|chopped|diced|minced|halved|peeled|shredded|grated|crushed|sliced)\b"
STOP = {"fresh", "raw", "whole", "large", "small", "organic"}

# a chocolate bar is not almond butter, ramen is not soy sauce, yogurt is not
# berries, baklava is not dates. these forms are never the raw ingredient.
FORM_DENY = ["ramen", "noodle", "candy", "chocolate", "protein bar", "granola bar",
             "snack pack", "yogurt", "ice cream", "cracker", "chips", "cookie",
             "baklava", "cereal bar", "trail mix", "drink mix", "seasoning packet",
             "pizza", "sandwich", "burrito", "smoothie"]
SKIP = {"water"}   # tap water is not a purchase

EACH_LB = {"avocado": 0.4, "lemon": 0.22, "lime": 0.18, "onion": 0.5, "bell pepper": 0.4,
           "banana": 0.28, "sweet potato": 0.55, "carrot": 0.15, "tomato": 0.35, "apple": 0.4,
           "orange": 0.45, "potato": 0.45, "cucumber": 0.7, "zucchini": 0.5}

CUP_OZ = {"baby spinach": 1.1, "spinach": 1.1, "mixed berries": 5.0, "berries": 5.0,
          "mixed vegetables": 5.5, "almonds": 5.0, "cashews": 4.8, "dates": 5.3,
          "walnuts": 4.0, "sliced almonds": 3.2, "rolled oats": 3.2, "cottage cheese": 8.0,
          "soy milk": 8.6, "unsweetened soy milk": 8.6, "water": 8.3, "flour": 4.4,
          "whole wheat flour": 4.5}

SPOONY = {"tsp", "tbsp", "pinch", "dash"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def need_oz(food, unit, qty):
    u = (unit or "").lower()
    f = food.lower()
    if u in SPOONY:
        return 0.5, "spoonful"
    if u == "g":
        return qty / 28.35, "weight"
    if u == "kg":
        return qty * 35.274, "weight"
    if u == "ml":
        return qty / 29.57, "volume"
    if u == "cup":
        return qty * CUP_OZ.get(f, 4.0), "volume"
    if u == "each":
        return qty * EACH_LB.get(f, 0.35) * 16, "each"
    if u == "clove":
        return 1.5, "each"
    if u == "slice":
        return qty * 1.2, "count"
    if u in ("can", "scoop"):
        return qty * 14.0, "count"
    return 4.0, "unknown"


def parse_size(s):
    if not s:
        return None
    s = s.lower().replace("fl oz", "floz")
    m = re.search(r"([\d.]+)\s*(lb|lbs|oz|floz|ct|ea|g|kg|l|liter|qt|gal|pt|ounce|bars|slices)", s)
    if not m:
        return None
    v, u = float(m.group(1)), m.group(2)
    return {"lb": v * 16, "lbs": v * 16, "kg": v * 35.274, "g": v / 28.35, "oz": v,
            "ounce": v, "floz": v, "l": v * 33.8, "liter": v * 33.8, "qt": v * 32,
            "gal": v * 128, "pt": v * 16, "ct": v * 3.0, "ea": v * 3.0,
            "bars": v * 1.4, "slices": v * 1.2}.get(u)


def pick(food, section, unit, qty):
    if food.lower().strip() in SKIP:
        return None
    term = re.sub(PREP, "", food, flags=re.I).strip()
    rows = search(term) or search(food)
    words = [w for w in re.split(r"\s+", term.lower()) if w and w not in STOP]
    oz, kind = need_oz(food, unit, qty)
    best = None
    for p in rows:
        it = (p.get("items") or [{}])[0]
        desc = p.get("description") or ""
        d = norm(desc)
        cats = {c.lower() for c in (p.get("categories") or [])}
        if cats & CAT_DENY:
            continue
        ok = CAT_OK.get(section, set())
        if ok and cats and not any(o in c for c in cats for o in ok):
            continue
        if not cats and section != "other":
            continue
        if not all(norm(w) in d for w in words):
            continue
        if any(norm(x) in d for x in FORM_DENY if norm(x) not in norm(term)):
            continue
        pr = it.get("price") or {}
        reg = pr.get("regular")
        if not reg:
            continue
        if (it.get("inventory") or {}).get("stockLevel") == "TEMPORARILY_OUT_OF_STOCK":
            continue
        sz = parse_size(it.get("size"))
        sold = it.get("soldBy")
        if sold == "WEIGHT":
            spend = round(float(reg) * max(oz / 16.0, 0.2), 2)
            how = "%.2f lb @ $%s/lb" % (oz / 16.0, reg)
        elif sz and sz > 0:
            packs = max(1, math.ceil(oz / sz))
            spend = round(float(reg) * packs, 2)
            how = "%d x %s" % (packs, it.get("size"))
        else:
            spend = float(reg)
            how = "1 x %s" % it.get("size")
        loose = 1 if (section == "produce" and kind == "each" and sold == "WEIGHT") else 0
        cand = dict(desc=desc, brand=p.get("brand"), upc=p.get("upc"), size=it.get("size"),
                    reg=float(reg), promo=pr.get("promo"), sold=sold, spend=spend, how=how,
                    aisle=((p.get("aisleLocations") or [{}])[0]).get("description"),
                    cats=sorted(cats), loose=loose)
        key = (-loose, spend, float(reg))
        if best is None or key < best[0]:
            best = (key, cand)
    return best[1] if best else None


data = json.load(io.open(LIST, encoding="utf-8"))
items = [i for i in data["items"] if not i.get("checked")]
print("list %s  rows %d  store %s (Marianos Vernon Hills)\n" % (data.get("generatedFrom"), len(items), LOC))

tot = promo_tot = 0.0
out = []
miss = []
for i in items:
    c = pick(i["food"], i.get("section", "other"), i.get("unit", ""), i.get("qty", 1))
    if not c:
        miss.append("%s (%s %s)" % (i["food"], i.get("qty"), i.get("unit")))
        continue
    tot += c["spend"]
    promo_tot += round(c["spend"] * (c["promo"] / c["reg"]), 2) if c["promo"] else c["spend"]
    out.append((i.get("section"), i["food"], "%s %s" % (i.get("qty"), i.get("unit")), c))

order = ["produce", "meat", "dairy", "grains", "bakery", "canned", "frozen",
         "baking", "spices", "condiments", "beverages", "other"]
for sec in order:
    sub = [r for r in out if r[0] == sec]
    if not sub:
        continue
    print("--- %s  $%.2f" % (sec.upper(), sum(r[3]["spend"] for r in sub)))
    for s_, food, need, c in sub:
        tag = "PROMO" if c["promo"] else ""
        print("   %-22s%11s  %-46s %-12s $%6.2f = $%7.2f %-5s [%s]"
              % (food, need, c["desc"][:46], str(c["size"])[:12], c["reg"], c["spend"], tag, c["how"]))

print("\nPRICED %d of %d" % (len(out), len(items)))
print("SUBTOTAL regular : $%.2f" % tot)
print("SUBTOTAL w/promo : $%.2f" % promo_tot)
print("NOT FOUND (%d): %s" % (len(miss), "; ".join(miss)))
