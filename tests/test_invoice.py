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

    def test_leading_customer_subject(self):
        # "<Name> bought <qty> <product> at <price> each" — customer opens the sentence.
        i = heuristic_extract("Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each")
        assert i.customer_query == "Adebayo Stores"
        assert len(i.lines) == 1
        assert i.lines[0].qty_text == "five"
        assert "cement" in i.lines[0].product_query


class TestCodeSwitchedPhrasing:
    """Common Pidgin / code-switched shapes that, before 2026-09-15, lost the customer
    or turned a payment term or a price into a product line."""

    @staticmethod
    def _draft(transcript: str) -> dict:
        return build_draft(heuristic_extract(transcript), ROSTER, {}, today="2026-09-14")

    def test_leading_abeg_keeps_the_customer(self):
        d = self._draft("Abeg, Adebayo Stores buy five bags of Dangote cement at twelve thousand five hundred naira each")
        assert d["customer"]["status"] == "resolved"
        assert d["ready"] and d["total_kobo"] == 6_250_000

    def test_pidgin_purchase_verb_keeps_the_customer(self):
        i = heuristic_extract("Adebayo Stores wan buy five bags of Dangote cement at twelve-five each")
        assert i.customer_query == "Adebayo Stores"
        assert i.lines[0].qty_text == "five" and i.lines[0].price_text == "twelve-five"

    def test_pidgin_payment_term_is_not_a_product(self):
        d = self._draft("Adebayo Stores buy five bags Dangote cement at twelve-five each, make dem pay in 14 days")
        assert len(d["lines"]) == 1
        assert d["ready"] and d["terms"]["days"] == 14

    def test_english_pay_in_days_is_a_term(self):
        i = heuristic_extract("Adebayo Stores bought 5 bags of Dangote cement, pay in fourteen days")
        assert len(i.lines) == 1
        assert i.terms_text == "pay in fourteen days"
        assert self._draft("Adebayo Stores bought 5 bags of Dangote cement, pay in fourteen days")["terms"]["days"] == 14

    def test_pidgin_term_with_number_words_keeps_the_days(self):
        d = self._draft("Adebayo Stores buy five bags Dangote cement at twelve-five each, make dem pay in seven days")
        assert d["terms"]["days"] == 7 and d["ready"]

    def test_price_after_a_comma_prices_the_previous_line(self):
        d = self._draft("Adebayo Stores wan buy five bags of Dangote cement, twelve-five each")
        assert len(d["lines"]) == 1
        assert d["lines"][0]["unit_price_kobo"] == 1_250_000 and d["ready"]

    def test_a_plain_second_item_is_never_taken_as_a_price(self):
        i = heuristic_extract("Adebayo Stores bought five bags of cement, two buckets of paint")
        assert len(i.lines) == 2
        assert i.lines[1].price_text == "" and "paint" in i.lines[1].product_query


class TestCustomerSelection:
    """Setting or changing the customer must let the invoice be created, and a
    customer named in ordinary speech (lowercase, mid-sentence) must be found."""

    @staticmethod
    def _draft(transcript: str, selections: dict | None = None) -> dict:
        return build_draft(heuristic_extract(transcript), ROSTER, selections or {}, today="2026-09-16")

    def test_confirmed_new_customer_is_ready_to_create(self):
        t = "Zainab Kachalla Global bought 2 bags of Dangote cement at twelve thousand five hundred naira each"
        blocked = self._draft(t)
        assert blocked["customer"]["status"] == "unknown" and not blocked["ready"]
        d = self._draft(t, {"customer_id": "NEW", "customer_new_name": "Zainab Kachalla Global"})
        assert d["customer"]["status"] == "new"
        assert d["customer"]["resolved"]["name"] == "Zainab Kachalla Global"
        assert d["questions"] == [] and d["ready"] and d["total_kobo"] == 2_500_000

    def test_changing_the_customer_to_a_roster_one_keeps_it_ready(self):
        d = self._draft("Musa bought two buckets of emulsion paint at eight thousand naira each",
                        {"customer_id": "c08"})
        assert d["customer"]["resolved"]["name"] == "Musa Hardware" and d["ready"]

    def test_lowercase_customer_after_to(self):
        d = self._draft("send 5 bags of dangote cement to adebayo stores at 12500 naira each")
        assert d["customer"]["resolved"]["name"] == "Adebayo Stores"
        assert d["lines"][0]["qty"] == 5 and d["lines"][0]["unit_price_kobo"] == 1_250_000
        assert d["ready"]

    def test_customer_named_before_the_quantity(self):
        d = self._draft("give ngozi ventures 20 roofing sheets")
        assert d["customer"]["resolved"]["name"] == "Ngozi Ventures"
        assert d["lines"][0]["qty"] == 20 and d["ready"]

    def test_invoice_name_for_items(self):
        d = self._draft("invoice adebayo stores for five bags of cement at twelve-five each")
        assert d["customer"]["resolved"]["name"] == "Adebayo Stores" and d["ready"]

    def test_customer_mid_sentence_is_not_left_in_the_product(self):
        i = heuristic_extract("10 lengths of iron rod to musa hardware at 8,500 each")
        assert i.customer_query == "musa hardware"
        assert "musa" not in i.lines[0].product_query.lower()

    def test_a_price_is_never_taken_as_a_customer(self):
        i = heuristic_extract("2 bags of cement for 12500 each")
        assert i.customer_query == ""
        assert i.lines[0].price_text == "12500"

    def test_no_customer_still_asks_instead_of_inventing_one(self):
        d = self._draft("5 bags of cement at 12500 each")
        assert d["customer"]["status"] == "missing" and not d["ready"]
        assert any(q["field"] == "customer" for q in d["questions"])


class TestDraftComputation:
    def _draft(self, transcript, selections=None):
        return build_draft(heuristic_extract(transcript), ROSTER, selections or {}, today="2026-09-14")

    def test_total_is_computed_by_the_money_engine(self):
        d = self._draft("invoice for 5 bags of cement at 12500 naira each for customer Musa")
        assert d["lines"][0]["line_total_kobo"] == 6_250_000
        assert d["total_display"] == "₦62,500"

    def test_example_phrasing_resolves_and_is_ready(self):
        # The on-screen example must actually parse end to end.
        d = self._draft("Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each")
        assert d["customer"]["resolved"]["name"] == "Adebayo Stores"
        assert d["total_display"] == "₦62,500"
        assert d["ready"] is True and d["questions"] == []

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
