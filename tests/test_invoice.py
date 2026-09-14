"""The invoice draft is where a transcript becomes money. Two things must hold:
every figure is computed by the money engine, and nothing uncertain is guessed —
it becomes a question instead."""
import json
from pathlib import Path

import pytest

from sautice.bridge import handle
from sautice.invoice.extract import heuristic_extract
from sautice.invoice.executor import build_draft
from sautice.invoice.roster import load_roster, resolve_customer, resolve_product

ROSTER = load_roster()
CUST = ROSTER["customers"]
PROD = ROSTER["products"]


class TestResolution:
    def test_exact_name_resolves_over_confusable_siblings(self):
        r = resolve_customer("Adebayo Stores", CUST)
        assert r["status"] == "resolved"
        assert r["resolved"]["id"] == "c01"

    def test_confusable_cluster_stays_ambiguous(self):
        r = resolve_customer("Musa", CUST)
        assert r["status"] == "ambiguous"
        assert {c["id"] for c in r["candidates"]} == {"c08", "c09"}

    def test_unknown_customer_is_not_snapped_to_nearest(self):
        assert resolve_customer("Zonatech Global", CUST)["status"] == "unknown"

    def test_product_alias_resolves(self):
        r = resolve_product("cement", PROD)
        assert r["status"] == "resolved" and r["resolved"]["id"] == "p01"

    def test_product_unknown(self):
        assert resolve_product("helicopter", PROD)["status"] == "unknown"


class TestExtraction:
    def test_pulls_qty_product_price_and_customer(self):
        i = heuristic_extract("invoice for 5 bags of cement at 12500 naira each for customer Musa")
        assert i.customer_query == "Musa"
        assert len(i.lines) == 1
        assert i.lines[0].qty_text == "5"
        assert "cement" in i.lines[0].product_query
        assert "12500" in i.lines[0].price_text

    def test_two_items(self):
        i = heuristic_extract("2 bags of cement at 12500 and 3 lengths of rod at 8500 for Adebayo Stores")
        assert len(i.lines) == 2
        assert i.customer_query == "Adebayo Stores"


class TestDraftComputation:
    def _draft(self, transcript, selections=None):
        return build_draft(heuristic_extract(transcript), ROSTER, selections or {}, today="2026-09-14")

    def test_total_is_computed_by_the_money_engine(self):
        d = self._draft("invoice for 5 bags of cement at 12500 naira each for customer Musa")
        assert d["lines"][0]["line_total_kobo"] == 6_250_000
        assert d["total_display"] == "₦62,500"

    def test_spoken_price_is_labelled_as_such(self):
        d = self._draft("invoice for 5 bags of cement at 12500 naira each for customer Musa")
        assert d["lines"][0]["unit_price_source"] == "spoken"

    def test_catalogue_price_used_when_none_spoken(self):
        d = self._draft("invoice for 2 bags of BUA for customer Adebayo Stores",
                        {"customer_id": "c01"})
        line = d["lines"][0]
        assert line["unit_price_source"] == "catalog"
        assert line["unit_price_kobo"] == 1_210_000
        assert line["line_total_kobo"] == 2_420_000

    def test_confusable_customer_blocks_ready_with_a_question(self):
        d = self._draft("invoice for 5 bags of cement at 12500 each for customer Musa")
        assert d["ready"] is False
        assert any(q["id"] == "customer" for q in d["questions"])

    def test_answering_the_question_makes_it_ready(self):
        d = self._draft("invoice for 5 bags of cement at 12500 each for customer Musa",
                        {"customer_id": "c08"})
        assert d["ready"] is True
        assert d["questions"] == []
        assert d["customer"]["resolved"]["name"] == "Musa Hardware"

    def test_ambiguous_amount_becomes_a_price_question_not_a_guess(self):
        # "two fifty" could be 250 / 2,500 / 250,000 — the grammar refuses to guess.
        d = self._draft("invoice for 2 bags of cement at two fifty each for customer Adebayo Stores")
        price_q = [q for q in d["questions"] if q["id"] == "line:0:price"]
        assert price_q, "expected a price clarification"
        assert d["lines"][0]["line_total_kobo"] is None

    def test_new_customer_is_offered_not_silently_created(self):
        d = self._draft("invoice for 5 bags of cement at 12500 each for customer Zonatech")
        cq = [q for q in d["questions"] if q["id"] == "customer"]
        assert cq and any(o["value"] == "NEW" for o in cq[0]["options"])

    def test_quantity_times_price_never_overflows_via_float(self):
        d = self._draft("invoice for 100 trips of granite for customer Adebayo Stores",
                        {"customer_id": "c01"})
        # 100 x 120,000.00 = 12,000,000.00
        assert d["lines"][0]["line_total_kobo"] == 100 * 12_000_000
        assert d["total_display"] == "₦12,000,000"


class TestBridgeProtocol:
    def test_handle_returns_ok_and_draft(self):
        resp = handle({"action": "draft", "transcript": "invoice for 5 bags of cement at 12500 each for customer Musa"})
        assert resp["ok"] is True
        assert "draft" in resp and "intent" in resp

    def test_unknown_action_is_reported_not_raised(self):
        assert handle({"action": "nope"})["ok"] is False

    def test_roster_is_valid_json_with_expected_shape(self):
        data = json.loads(Path(load_roster.__globals__["DEFAULT_ROSTER"]).read_text(encoding="utf-8"))
        assert data["customers"] and data["products"]
