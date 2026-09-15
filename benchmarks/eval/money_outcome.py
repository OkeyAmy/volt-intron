"""Track 2: money outcome via the locked Sautice invoice engine.

For each provider hypothesis under a SautiBench scenario, run the deterministic
pipeline (heuristic_extract -> build_draft, with the checked-in roster) and
classify the money risk:

    exact      draft total == expected total, no questions asked
    off_small  priced draft, deviation <= 10% of expected total
    catastrophic deviation > 10% (a wrong invoice the cash register cannot catch)
    blocked    engine asked questions instead of pricing (safe default)

A transcript that "sounds fluent" but says 645 instead of 64,500 is catastrophic
here even if WER looks fine - that is the entire point of this track.
"""
from __future__ import annotations

import json
from pathlib import Path

from sautice.invoice.executor import build_draft
from sautice.invoice.extract import heuristic_extract

ROSTER_PATH = Path(__file__).resolve().parents[1] / "data" / "sautibench" / "roster.json"
SCENARIOS_PATH = Path(__file__).resolve().parents[1] / "data" / "sautibench" / "scenarios.json"


def load_roster(path: Path = ROSTER_PATH) -> dict:
    return json.loads(Path(path).read_text())


def load_scenarios(path: Path = SCENARIOS_PATH) -> dict:
    return json.loads(Path(path).read_text())


def score_scenario(hypothesis: str, scenario: dict, roster: dict,
                   today: str = "2026-09-15") -> dict:
    """Run one hypothesis through the Sautice engine and score money risk."""
    expected = scenario.get("expected", {})
    exp_items = expected.get("items", [])
    exp_total = expected.get("total_kobo")

    intent = heuristic_extract(hypothesis or "")
    draft = build_draft(intent, roster, selections={}, today=today)

    lines = draft.get("lines", [])
    priced_total = draft.get("total_kobo")

    qty_correct = False
    price_correct = False
    items_match = len(lines) == len(exp_items)
    if items_match:
        qty_correct = all(
            (ln.get("qty") if "qty" in ln else None) == item.get("quantity")
            for ln, item in zip(lines, exp_items)
        )
        price_correct = all(
            ln.get("unit_price_kobo") == item.get("unit_price_kobo")
            for ln, item in zip(lines, exp_items)
        )

    total_exact = exp_total is not None and priced_total == exp_total
    ready = bool(draft.get("ready"))

    outcome = "blocked"
    if ready and total_exact:
        outcome = "exact"
    elif ready and priced_total is not None and exp_total:
        dev = abs(priced_total - exp_total) / exp_total
        outcome = "catastrophic" if dev > 0.10 else "off_small"

    return {
        "scenario_id": scenario.get("id"),
        "ready": ready,
        "blocked_questions": [q.get("id") for q in draft.get("questions", [])],
        "customer_resolved": draft.get("customer", {}).get("status") == "resolved",
        "items_match": items_match,
        "qty_correct": qty_correct,
        "price_correct": price_correct,
        "total_exact_kobo": total_exact,
        "draft_total_kobo": priced_total,
        "expected_total_kobo": exp_total,
        "outcome": outcome,
    }


def diagnose_transcript(hypothesis: str, roster: dict) -> dict:
    """Diagnostic pass for non-scenario cells: does this transcript parse into
    invoice intent at all? No kobo ground truth, so no money risk label."""
    intent = heuristic_extract(hypothesis or "")
    draft = build_draft(intent, roster, selections={})
    return {
        "mode": "diagnostic",
        "ready": bool(draft.get("ready")),
        "n_lines_detected": len(draft.get("lines", [])),
        "blocked_questions": [q.get("id") for q in draft.get("questions", [])],
        "draft_total_kobo": draft.get("total_kobo"),
    }


def summarize_outcomes(scores: list[dict]) -> dict:
    """Only count cells that carry a scored 'outcome'; skip diagnostic-only cells
    that lack it."""
    scores = [s for s in scores if "outcome" in s]
    n = len(scores)
    if n == 0:
        return {"n": 0}
    return {
        "n": n,
        "exact": sum(1 for s in scores if s["outcome"] == "exact"),
        "off_small": sum(1 for s in scores if s["outcome"] == "off_small"),
        "catastrophic": sum(1 for s in scores if s["outcome"] == "catastrophic"),
        "blocked": sum(1 for s in scores if s["outcome"] == "blocked"),
        "ready": sum(1 for s in scores if s["ready"]),
        "exact_rate": round(
            sum(1 for s in scores if s["outcome"] == "exact") / n, 4) if n else None,
    }