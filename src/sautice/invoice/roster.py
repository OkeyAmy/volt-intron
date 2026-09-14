"""Workspace roster: customers and a product catalogue, with name resolution.

Resolution never "snaps" to the nearest name. A single clear match resolves; a
tie inside a confusable cluster (Adebayo Stores vs Adebayo Ventures) stays
ambiguous and becomes a question; nothing recognisable becomes a candidate new
entity. The roster is demonstration data — real workspaces are loaded the same way.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# repo_root/benchmarks/data/sautibench/roster.json ; this file is src/sautice/invoice/roster.py
DEFAULT_ROSTER = Path(__file__).resolve().parents[3] / "benchmarks" / "data" / "sautibench" / "roster.json"


def load_roster(path: str | Path | None = None) -> dict[str, Any]:
    p = Path(path) if path else DEFAULT_ROSTER
    return json.loads(p.read_text(encoding="utf-8"))


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()


def _tokens(s: str) -> set[str]:
    # Drop tokens that carry no identity, so "Musa" matches "Musa Hardware".
    stop = {"stores", "store", "ltd", "limited", "nig", "nigeria", "co", "company",
            "enterprises", "ventures", "trading", "global", "concept", "services",
            "and", "sons", "brothers", "&"}
    return {t for t in _norm(s).split() if t and t not in stop}


def resolve_customer(query: str, customers: list[dict]) -> dict[str, Any]:
    q = _norm(query)
    if not q:
        return {"status": "missing", "query": query, "candidates": []}

    exact = [c for c in customers if _norm(c["name"]) == q]
    if len(exact) == 1:
        return {"status": "resolved", "query": query,
                "resolved": _cust(exact[0]), "candidates": [_cust(exact[0])]}

    qt = _tokens(query)
    hits = []
    for c in customers:
        name_n = _norm(c["name"])
        overlap = len(qt & _tokens(c["name"]))
        if q and q in name_n:
            hits.append((overlap + 5, c))
        elif overlap:
            hits.append((overlap, c))
    hits.sort(key=lambda x: -x[0])

    if not hits:
        return {"status": "unknown", "query": query, "candidates": []}
    top = hits[0][0]
    tied = [c for s, c in hits if s == top]
    if len(tied) == 1:
        return {"status": "resolved", "query": query,
                "resolved": _cust(tied[0]), "candidates": [_cust(c) for _, c in hits[:5]]}
    return {"status": "ambiguous", "query": query, "candidates": [_cust(c) for _, c in hits[:5]]}


def resolve_product(query: str, products: list[dict]) -> dict[str, Any]:
    q = _norm(query)
    if not q:
        return {"status": "missing", "query": query, "candidates": []}

    exact = [p for p in products if _norm(p["name"]) == q]
    if len(exact) == 1:
        return {"status": "resolved", "query": query,
                "resolved": _prod(exact[0]), "candidates": [_prod(exact[0])]}

    qt = _tokens_prod(query)
    hits = []
    for p in products:
        names = [p["name"], *p.get("aliases", [])]
        alias_hit = any(_norm(a) in q or q in _norm(a) for a in p.get("aliases", []))
        overlap = max((len(qt & _tokens_prod(n)) for n in names), default=0)
        if alias_hit:
            hits.append((overlap + 5, p))
        elif overlap:
            hits.append((overlap, p))
    hits.sort(key=lambda x: -x[0])

    if not hits:
        return {"status": "unknown", "query": query, "candidates": []}
    top = hits[0][0]
    tied = [p for s, p in hits if s == top]
    if len(tied) == 1:
        return {"status": "resolved", "query": query,
                "resolved": _prod(tied[0]), "candidates": [_prod(p) for _, p in hits[:5]]}
    return {"status": "ambiguous", "query": query, "candidates": [_prod(p) for _, p in hits[:5]]}


def _tokens_prod(s: str) -> set[str]:
    stop = {"the", "a", "of", "and"}
    return {t for t in _norm(s).split() if t and t not in stop}


def _cust(c: dict) -> dict:
    return {"id": c["id"], "name": c["name"]}


def _prod(p: dict) -> dict:
    return {"id": p["id"], "name": p["name"], "unit": p.get("unit"),
            "unit_price_kobo": p["unit_price_kobo"]}


def find_customer(cid: str, customers: list[dict]) -> dict | None:
    for c in customers:
        if c["id"] == cid:
            return _cust(c)
    return None


def find_product(pid: str, products: list[dict]) -> dict | None:
    for p in products:
        if p["id"] == pid:
            return _prod(p)
    return None
