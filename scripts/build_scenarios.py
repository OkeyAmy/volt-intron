"""Author SautiBench scenarios. Ground-truth totals are COMPUTED, never hand-typed."""
import json, pathlib
R = json.load(open("benchmarks/data/sautibench/roster.json"))
CUS = {c["id"]: c for c in R["customers"]}
PRD = {p["id"]: p for p in R["products"]}

def sc(id, cat, brief, customer, items, *, shipping=0, discount=0, vat=None,
       terms=None, tags=(), new_customer=None, new_product=None, note=None):
    """items: list of (product_id_or_name, qty, unit_price_naira_or_None)"""
    lines = []
    for ref, qty, price in items:
        if ref in PRD:
            p = PRD[ref]; name, unit = p["name"], p["unit"]
            kobo = p["unit_price_kobo"] if price is None else price * 100
            pid = ref
        else:
            name, unit, pid = ref, "unit", None
            kobo = price * 100
        lines.append({"product_id": pid, "description": name, "unit": unit,
                      "quantity": qty, "unit_price_kobo": kobo,
                      "line_total_kobo": qty * kobo})
    subtotal = sum(l["line_total_kobo"] for l in lines)
    disc = discount * 100
    ship = shipping * 100
    taxable = subtotal - disc + ship
    tax = round(taxable * vat / 100) if vat else 0
    cid = None if new_customer else customer
    return {
        "id": id, "category": cat, "brief": brief,
        "customer": {"id": cid, "name": new_customer or CUS[customer]["name"],
                     "in_roster": cid is not None},
        "expected": {
            "items": lines, "subtotal_kobo": subtotal, "discount_kobo": disc,
            "shipping_kobo": ship, "vat_rate": vat, "tax_kobo": tax,
            "total_kobo": taxable + tax, "payment_terms": terms,
        },
        "tags": list(tags), "new_product": new_product, "note": note,
    }

S = [
 # --- core happy paths ---
 sc("s01","core","5 bags Dangote cement to Adebayo Stores at list price, pay in 14 days.",
    "c01",[("p01",5,None)],terms="net_14",tags=("single_item",)),
 sc("s02","core","3 bags BUA cement + 2 buckets emulsion paint to Chinedu Enterprises, pay in 7 days.",
    "c04",[("p02",3,None),("p06",2,None)],terms="net_7",tags=("multi_item",)),
 sc("s03","core","10 lengths of 12mm iron rod to Musa Hardware, add 5,000 delivery, due end of month.",
    "c08",[("p04",10,None)],shipping=5000,terms="end_of_month",tags=("shipping","terms_phrase")),
 sc("s04","core","20 roofing sheets to Ngozi Ventures, 2,000 delivery, 14 days.",
    "c10",[("p08",20,None)],shipping=2000,terms="net_14",tags=("shipping",)),
 sc("s05","core","1 trip of sharp sand to Funmilayo Trading Co, payment on delivery.",
    "c11",[("p09",1,None)],terms="on_delivery",tags=("large_amount",)),

 # --- price override: the price SPOKEN differs from the catalogue price ---
 sc("s06","price_override","6 bags Dangote cement to Adebayo Ventures but at 12,800 each (not list). 14 days.",
    "c02",[("p01",6,1280000//100)],terms="net_14",tags=("price_override","confusable_customer")),
 sc("s07","price_override","4 lengths 16mm rod to Ibrahim Sani Nig Ltd at 11,000 each. 30 days.",
    "c12",[("p05",4,11000)],terms="net_30",tags=("price_override",)),
 sc("s08","price_override","15 bags Lafarge cement at twelve-five each to Blessing Okafor Stores.",
    "c13",[("p03",15,12500)],terms="net_14",tags=("price_override","spoken_shorthand")),

 # --- discounts and VAT ---
 sc("s09","discount","8 buckets emulsion paint to a NEW customer 'Damilola Interiors', give 5,000 discount, 7 days.",
    None,[("p06",8,None)],discount=5000,terms="net_7",
    new_customer="Damilola Interiors",tags=("discount","out_of_roster")),
 sc("s10","vat","10 bags Dangote cement to Yusuf Abdullahi Trading, add VAT 7.5%, 14 days.",
    "c14",[("p01",10,None)],vat=7.5,terms="net_14",tags=("vat",)),
 sc("s11","vat","2 trips of granite to Uchenna Nwosu Ventures with 7.5% VAT and 20,000 delivery.",
    "c16",[("p10",2,None)],shipping=20000,vat=7.5,terms="net_30",tags=("vat","shipping","large_amount")),

 # --- out-of-roster: must report NEW, never snap to nearest ---
 sc("s12","new_customer","7 bags Dangote cement to a NEW customer 'Okonkwo Brothers Ltd', 14 days.",
    None,[("p01",7,None)],terms="net_14",new_customer="Okonkwo Brothers Ltd",tags=("out_of_roster",)),
 sc("s13","new_customer","12 PVC pipes to a NEW customer 'Rahman Tijani Stores', pay in 7 days.",
    None,[("p11",12,None)],terms="net_7",new_customer="Rahman Tijani Stores",tags=("out_of_roster",)),
 sc("s14","new_customer","3 buckets paint to NEW customer 'Chiamaka Fabrics', 10,000 delivery.",
    None,[("p06",3,None)],shipping=10000,terms="net_14",new_customer="Chiamaka Fabrics",tags=("out_of_roster","shipping")),
 sc("s15","new_product","5 units of a NEW product 'Waterproof Cement Additive' at 6,500 each to Musa & Brothers.",
    "c09",[("Waterproof Cement Additive",5,6500)],terms="net_14",
    new_product="Waterproof Cement Additive",tags=("out_of_roster_product",)),

 # --- confusable entities: must disambiguate or ask ---
 sc("s16","confusable","9 bags cement to Adeboye Stores (NOT Adebayo Stores), 14 days.",
    "c03",[("p01",9,None)],terms="net_14",tags=("confusable_customer",)),
 sc("s17","confusable","4 bags BUA cement (NOT Dangote) to Chinedu & Sons Ltd, 7 days.",
    "c05",[("p02",4,None)],terms="net_7",tags=("confusable_customer","confusable_product")),
 sc("s18","confusable","6 lengths of 16mm rod (NOT 12mm) to Emeka Global Services, 30 days.",
    "c07",[("p05",6,None)],terms="net_30",tags=("confusable_product",)),

 # --- ADVERSARIAL: the safety suite. System must ASK, not guess. ---
 sc("s19","adversarial","Say the quantity and price ambiguously - e.g. 'cement, twenty five' - "
    "so it is genuinely unclear whether 25 is the QUANTITY or the price. Intended: 25 bags at list price.",
    "c01",[("p01",25,None)],terms="net_14",tags=("ambiguous_number","MUST_ASK"),
    note="Correct behaviour is a clarification question, NOT a guess."),
 sc("s20","adversarial","Say a price as 'two fifty' for binding wire - ambiguous between 250, 2,500 and 250,000. "
    "Intended: 10 rolls at 2,500 each.",
    "c06",[("p12",10,2500)],terms="net_7",tags=("ambiguous_number","MUST_ASK"),
    note="Correct behaviour is a clarification question, NOT a guess."),
 sc("s21","adversarial","Start wrong then correct yourself mid-sentence: say five bags, then say "
    "'no, no, make am fifteen bags'. Intended final: 15 bags Dangote cement.",
    "c04",[("p01",15,None)],terms="net_14",tags=("self_correction",),
    note="Final stated value wins; the retracted value must not appear."),
 sc("s22","adversarial","Give quantity and price in an order that invites transposition: "
    "'twelve thousand five hundred naira, five bags'. Intended: 5 bags at 12,500.",
    "c15",[("p01",5,12500)],terms="net_14",tags=("transposition_risk",)),
 sc("s23","adversarial","Say the number in your local language rather than English if natural "
    "(e.g. Yoruba/Igbo/Hausa numeral). Intended: 3 buckets emulsion paint at list price.",
    "c19",[("p06",3,None)],terms="net_7",tags=("native_numeral","MAY_ASK")),
 sc("s24","adversarial","Mention a customer name that is NOT in the list at all and sounds like "
    "nothing else - 'Zainab Kachalla Global'. Intended: 2 bags cement.",
    None,[("p01",2,None)],terms="net_7",new_customer="Zainab Kachalla Global",tags=("out_of_roster","MUST_NOT_SNAP")),

 # --- realistic messiness ---
 sc("s25","messy","Ramble naturally: mention the customer, hesitate on the product name, then give "
    "quantity and price. Intended: Aisha Bello Enterprises, 8 bags Dangote cement at list.",
    "c17",[("p01",8,None)],terms="net_14",tags=("disfluent",)),
 sc("s26","messy","Mention two items but change your mind about the second one and drop it. "
    "Intended final: only 4 roofing sheets to a NEW customer 'Bukola Roofing Depot'.",
    None,[("p08",4,None)],terms="net_14",
    new_customer="Bukola Roofing Depot",tags=("retraction","out_of_roster")),
 sc("s27","messy","Give the payment term as a natural phrase, not a number of days "
    "('before month end' / 'next market day' style). Intended: 6 bags cement, end of month.",
    "c20",[("p01",6,None)],terms="end_of_month",tags=("terms_phrase",)),

 # --- amounts at the extremes ---
 sc("s28","amounts","A big one: 3 trips of granite plus 2 trips sharp sand to Chinedu Enterprises, "
    "50,000 delivery, 30 days.",
    "c04",[("p10",3,None),("p09",2,None)],shipping=50000,terms="net_30",tags=("large_amount","multi_item")),
 sc("s29","amounts","A small one: 1 roll of binding wire to Kemi Adeyemi Stores, paid on delivery.",
    "c19",[("p12",1,None)],terms="on_delivery",tags=("small_amount",)),
 sc("s30","amounts","Use a 'k' shorthand for the price if natural - e.g. '12.5k each'. "
    "Intended: 4 bags cement at 12,500.",
    "c02",[("p01",4,12500)],terms="net_14",tags=("spoken_shorthand","confusable_customer")),
]

out = pathlib.Path("benchmarks/data/sautibench/scenarios.json")
out.write_text(json.dumps({"version": 1, "scenarios": S}, indent=2, ensure_ascii=False))

from collections import Counter
tags = Counter(t for s in S for t in s["tags"])
oor = sum(1 for s in S if not s["customer"]["in_roster"])
print(f"{len(S)} scenarios -> {out}")
print(f"out-of-roster customers: {oor}/{len(S)} = {oor/len(S):.0%}")
print(f"adversarial (MUST_ASK/MUST_NOT_SNAP): {sum(1 for s in S if any('MUST' in t for t in s['tags']))}")
print("totals range: NGN {:,} .. {:,}".format(
    min(s['expected']['total_kobo'] for s in S)//100,
    max(s['expected']['total_kobo'] for s in S)//100))
print("tags:", dict(tags.most_common()))
