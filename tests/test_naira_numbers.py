"""Spoken Nigerian money.

The parser's job is not to be clever. It is to be right, or to say it cannot tell.
A confident wrong amount is the worst outcome in this product, so anything genuinely
ambiguous must come back as multiple candidates and force a question.
"""
from decimal import Decimal
import pytest
from sautice.core.money import Money
from sautice.nlp.naira import read_amount, read_quantity, read_percent, read_term_days


def N(s):           # brevity in assertions
    return Money.from_naira(s)


class TestPlainAmounts:
    @pytest.mark.parametrize("spoken,expected", [
        ("12500",                    "12500"),
        ("12,500",                   "12500"),
        ("₦12,500",                  "12500"),
        ("N12500",                   "12500"),
        ("12500 naira",              "12500"),
        ("twelve thousand five hundred", "12500"),
        ("five hundred",             "500"),
        ("two thousand",             "2000"),
        ("eighteen thousand five hundred", "18500"),
        ("one million",              "1000000"),
        ("nine hundred and fifty",   "950"),
    ])
    def test_unambiguous_amounts(self, spoken, expected):
        r = read_amount(spoken)
        assert not r.is_ambiguous, f"{spoken!r} should be unambiguous, got {r.candidates}"
        assert r.value == N(expected)


class TestNigerianShorthand:
    @pytest.mark.parametrize("spoken,expected", [
        ("12.5k",        "12500"),
        ("12.5K",        "12500"),
        ("500k",         "500000"),
        ("1.5m",         "1500000"),
        ("2M",           "2000000"),
    ])
    def test_k_and_m_suffixes(self, spoken, expected):
        assert read_amount(spoken).value == N(expected)

    @pytest.mark.parametrize("spoken,expected", [
        ("twelve-five",  "12500"),
        ("twelve five",  "12500"),
        ("eighteen-five","18500"),
        ("three-five",   "3500"),
    ])
    def test_hyphenated_thousands_shorthand(self, spoken, expected):
        """'twelve-five' means 12,500 — standard trader shorthand for a price."""
        r = read_amount(spoken)
        assert not r.is_ambiguous
        assert r.value == N(expected)


class TestAmbiguityIsReported:
    def test_two_fifty_is_ambiguous(self):
        r = read_amount("two fifty")
        assert r.is_ambiguous
        assert set(r.candidates) == {N("250"), N("2500"), N("250000")}

    def test_ambiguous_reading_refuses_to_give_a_value(self):
        with pytest.raises(ValueError, match="ambiguous"):
            _ = read_amount("two fifty").value

    def test_ambiguous_reading_explains_itself_for_the_question(self):
        assert "250" in read_amount("two fifty").note

    def test_bare_twenty_five_is_ambiguous_in_amount_context(self):
        r = read_amount("twenty five")
        assert r.is_ambiguous
        assert N("25") in r.candidates and N("25000") in r.candidates

    def test_explicit_naira_removes_the_ambiguity(self):
        r = read_amount("twenty five thousand naira")
        assert not r.is_ambiguous
        assert r.value == N("25000")

    def test_unreadable_text_is_not_a_silent_zero(self):
        r = read_amount("as e dey go")
        assert r.is_ambiguous or r.candidates == ()
        assert r.value_or_none is None


class TestQuantities:
    @pytest.mark.parametrize("spoken,expected", [
        ("5", 5), ("five", 5), ("twelve", 12), ("twenty five", 25),
        ("a dozen", 12), ("3 bags", 3), ("fifteen bags", 15),
    ])
    def test_reads_whole_quantities(self, spoken, expected):
        assert read_quantity(spoken).value == expected

    def test_quantity_rejects_fractional(self):
        assert read_quantity("2.5").is_ambiguous or read_quantity("2.5").value_or_none is None

    def test_quantity_zero_is_invalid(self):
        assert read_quantity("0").value_or_none is None


class TestPercent:
    @pytest.mark.parametrize("spoken,expected", [
        ("7.5%", "7.5"), ("7.5 percent", "7.5"),
        ("seven point five percent", "7.5"), ("five percent", "5"),
        ("VAT", "7.5"),
    ])
    def test_reads_rates(self, spoken, expected):
        assert read_percent(spoken) == Decimal(expected)

    def test_unknown_rate_is_none_not_a_guess(self):
        assert read_percent("add some tax") is None


class TestPaymentTerms:
    @pytest.mark.parametrize("spoken,days", [
        ("14 days", 14), ("fourteen days", 14), ("two weeks", 14),
        ("one week", 7), ("a month", 30), ("30 days", 30),
        ("on delivery", 0), ("cash", 0),
    ])
    def test_reads_terms(self, spoken, days):
        assert read_term_days(spoken) == days

    def test_end_of_month_is_a_named_term_not_a_day_count(self):
        assert read_term_days("end of month") == "end_of_month"

    def test_unknown_term_is_none(self):
        assert read_term_days("when he ready") is None
