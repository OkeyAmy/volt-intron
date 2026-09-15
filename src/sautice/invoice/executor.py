"""Turn an intent + the user's selections into a fully computed draft.

Rules that matter:
  - Every naira figure is an integer-kobo Money value computed here, never in the
    model or the browser.
  - A confusable or missing entity, or an ambiguous amount, becomes a question.
    The draft is `ready` only when nothing is left to ask.
  - A price spoken in the sentence overrides the catalogue price, and is labelled
    as such so the reviewer can see it.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any

from sautice.core.money import Money, MoneyError
from sautice.nlp.naira import read_amount, read_quantity, read_term_days

from .extract import Intent
from .roster import find_customer, find_product, resolve_customer, resolve_product


def build_draft(intent: Intent, roster: dict, selections: dict | None = None,
                today: str | None = None) -> dict[str, Any]:
    selections = selections or {}
    customers = roster.get("customers", [])
    products = roster.get("products", [])
    questions: list[dict] = []

    customer = _resolve_customer(intent, selections, customers, questions)
    line_sel = selections.get("lines", [])
    lines: list[dict] = []
    for i, ln in enumerate(intent.lines):
        sel = line_sel[i] if i < len(line_sel) else {}
        lines.append(_build_line(i, ln, sel, products, questions))

    total_kobo = 0
    priced = True
    for ln in lines:
        if ln["line_total_kobo"] is None:
            priced = False
        else:
            total_kobo += ln["line_total_kobo"]

    terms = _resolve_terms(intent.terms_text, today)

    # A customer the user explicitly confirmed as new is as good as one from the
    # roster: the draft must be creatable, or "New customer" would be a dead end.
    ready = not questions and bool(lines) and priced and customer["status"] in ("resolved", "new")
    return {
        "customer": customer,
        "lines": lines,
        "terms": terms,
        "total_kobo": total_kobo if priced and lines else None,
        "total_display": Money.from_kobo(total_kobo).format() if priced and lines else None,
        "questions": questions,
        "ready": ready,
    }


def _resolve_customer(intent: Intent, selections: dict, customers: list, questions: list) -> dict:
    cid = selections.get("customer_id")
    if cid == "NEW":
        name = (selections.get("customer_new_name") or intent.customer_query or "").strip()
        return {"status": "new", "query": intent.customer_query, "resolved": {"id": None, "name": name, "new": True}}
    if cid:
        found = find_customer(cid, customers)
        if found:
            return {"status": "resolved", "query": intent.customer_query, "resolved": found}

    res = resolve_customer(intent.customer_query, customers)
    if res["status"] == "ambiguous":
        questions.append({
            "id": "customer", "kind": "choice", "field": "customer",
            "prompt": f"Which customer did you mean by '{res['query']}'?",
            "options": [{"value": c["id"], "label": c["name"]} for c in res["candidates"]]
                       + [{"value": "NEW", "label": f"New customer: {res['query']}"}],
        })
    elif res["status"] in ("unknown", "missing"):
        q = res.get("query") or ""
        questions.append({
            "id": "customer", "kind": "confirm_new" if q else "text", "field": "customer",
            "prompt": (f"'{q}' isn't in your customers. Add as a new customer?" if q
                       else "Who is this invoice for?"),
            "options": ([{"value": "NEW", "label": f"New customer: {q}"}] if q else []),
        })
    return res


def _build_line(i: int, line, sel: dict, products: list, questions: list) -> dict:
    # --- product ---
    pid = sel.get("product_id")
    if pid == "NEW":
        product = {"status": "new", "resolved": {"id": None, "name": sel.get("product_new_name") or line.product_query, "new": True, "unit_price_kobo": None}}
    elif pid:
        found = find_product(pid, products)
        product = {"status": "resolved", "resolved": found} if found else resolve_product(line.product_query, products)
    else:
        product = resolve_product(line.product_query, products)

    if product["status"] == "ambiguous":
        questions.append({
            "id": f"line:{i}:product", "kind": "choice", "field": "product", "line": i,
            "prompt": f"Which product did you mean by '{line.product_query}'?",
            "options": [{"value": p["id"], "label": f"{p['name']} - {Money.from_kobo(p['unit_price_kobo']).format()}"} for p in product["candidates"]],
        })
    elif product["status"] in ("unknown", "missing"):
        questions.append({
            "id": f"line:{i}:product", "kind": "confirm_new" if line.product_query else "text", "field": "product", "line": i,
            "prompt": (f"'{line.product_query}' isn't in your catalogue. Add it?" if line.product_query
                       else "What product is this line?"),
            "options": ([{"value": "NEW", "label": f"New product: {line.product_query}"}] if line.product_query else []),
        })

    resolved_product = product.get("resolved")

    # --- quantity ---
    qty = None
    if sel.get("qty") is not None:
        qty = int(sel["qty"])
    else:
        r = read_quantity(line.qty_text) if line.qty_text else None
        if r is None or not r.candidates:
            questions.append({"id": f"line:{i}:qty", "kind": "number", "field": "qty", "line": i,
                              "prompt": f"How many for '{line.product_query or 'this item'}'?"})
        elif r.is_ambiguous:
            questions.append({"id": f"line:{i}:qty", "kind": "choice", "field": "qty", "line": i,
                              "prompt": f"What quantity - {r.note}?",
                              "options": [{"value": c, "label": str(c)} for c in r.candidates]})
        else:
            qty = r.value

    # --- unit price ---
    unit_price_kobo = None
    unit_price_source = None
    if sel.get("unit_price_naira") is not None:
        try:
            unit_price_kobo = Money.from_naira(str(sel["unit_price_naira"])).kobo
            unit_price_source = "corrected"
        except MoneyError:
            questions.append({"id": f"line:{i}:price", "kind": "amount", "field": "price", "line": i,
                              "prompt": f"That price didn't read as a naira amount. What is the unit price?"})
    elif line.price_text:
        r = read_amount(line.price_text)
        if not r.candidates:
            questions.append({"id": f"line:{i}:price", "kind": "amount", "field": "price", "line": i,
                              "prompt": f"What is the unit price for '{line.product_query or 'this item'}'?"})
        elif r.is_ambiguous:
            questions.append({"id": f"line:{i}:price", "kind": "choice", "field": "price", "line": i,
                              "prompt": f"What price - {r.note}?",
                              "options": [{"value": str(c.naira), "label": c.format()} for c in r.candidates]})
        else:
            unit_price_kobo = r.value.kobo
            unit_price_source = "spoken"
    elif resolved_product and resolved_product.get("unit_price_kobo") is not None:
        unit_price_kobo = resolved_product["unit_price_kobo"]
        unit_price_source = "catalog"
    else:
        # No spoken price and no catalogue price (e.g. a new product).
        if product["status"] not in ("ambiguous", "unknown", "missing"):
            questions.append({"id": f"line:{i}:price", "kind": "amount", "field": "price", "line": i,
                              "prompt": f"What is the unit price for '{(resolved_product or {}).get('name') or line.product_query or 'this item'}'?"})

    line_total_kobo = None
    if qty is not None and unit_price_kobo is not None:
        line_total_kobo = (Money.from_kobo(unit_price_kobo) * qty).kobo

    return {
        "index": i,
        "query": line.product_query,
        "product": product,
        "qty": qty,
        "unit_price_kobo": unit_price_kobo,
        "unit_price_display": Money.from_kobo(unit_price_kobo).format() if unit_price_kobo is not None else None,
        "unit_price_source": unit_price_source,
        "line_total_kobo": line_total_kobo,
        "line_total_display": Money.from_kobo(line_total_kobo).format() if line_total_kobo is not None else None,
    }


def _resolve_terms(terms_text: str, today: str | None) -> dict:
    if not terms_text:
        return {"text": "", "days": None, "due_date": None}
    days = read_term_days(terms_text)
    base = _parse_today(today)
    due = None
    if isinstance(days, int):
        due = (base + timedelta(days=days)).isoformat()
    elif days == "end_of_month":
        last = calendar.monthrange(base.year, base.month)[1]
        due = date(base.year, base.month, last).isoformat()
    return {"text": terms_text, "days": days if isinstance(days, int) else None,
            "rule": days if isinstance(days, str) else None, "due_date": due}


def _parse_today(today: str | None) -> date:
    if today:
        try:
            return date.fromisoformat(today)
        except ValueError:
            pass
    return date.today()
