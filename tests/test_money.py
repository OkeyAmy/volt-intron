"""Money is integer kobo. Never a float. Ever."""
from decimal import Decimal
import pytest
from sautice.core.money import Money, MoneyError


class TestConstruction:
    def test_naira_amount_is_stored_as_integer_kobo(self):
        assert Money.from_naira("12500").kobo == 1_250_000

    def test_kobo_precision_survives(self):
        assert Money.from_naira("12500.37").kobo == 1_250_037

    def test_accepts_int_naira(self):
        assert Money.from_naira(2000).kobo == 200_000

    def test_accepts_decimal_naira(self):
        assert Money.from_naira(Decimal("7.50")).kobo == 750

    def test_rejects_float_because_floats_lose_money(self):
        with pytest.raises(MoneyError, match="float"):
            Money.from_naira(12500.37)

    def test_rejects_more_than_two_decimal_places(self):
        with pytest.raises(MoneyError, match="kobo"):
            Money.from_naira("12.345")

    def test_rejects_unparseable_string(self):
        with pytest.raises(MoneyError):
            Money.from_naira("twelve thousand")

    def test_zero(self):
        assert Money.zero().kobo == 0


class TestArithmetic:
    def test_addition(self):
        assert (Money.from_naira("100") + Money.from_naira("50.25")).kobo == 15_025

    def test_subtraction(self):
        assert (Money.from_naira("100") - Money.from_naira("40")).kobo == 6_000

    def test_multiplication_by_whole_quantity_is_exact(self):
        assert (Money.from_naira("12500") * 5).kobo == 6_250_000

    def test_multiplication_by_quantity_rejects_float(self):
        with pytest.raises(MoneyError, match="float"):
            Money.from_naira("100") * 2.5

    def test_can_be_negative_for_discounts(self):
        assert (Money.from_naira("10") - Money.from_naira("25")).kobo == -1_500

    def test_sum_of_many(self):
        assert Money.sum([Money.from_naira("1.01")] * 3).kobo == 303

    def test_sum_of_nothing_is_zero(self):
        assert Money.sum([]).kobo == 0


class TestRateApplication:
    """VAT and discounts. Rounding must be explicit and half-up, like a cash till."""

    def test_seven_point_five_percent_of_125000(self):
        # 125,000.00 * 0.075 = 9,375.00 exactly
        assert Money.from_naira("125000").apply_rate(Decimal("7.5")).kobo == 937_500

    def test_rounds_half_up_not_bankers(self):
        # 0.05 kobo cases must round away from zero, not to even
        assert Money.from_naira("0.05").apply_rate(Decimal("50")).kobo == 3  # 2.5 -> 3

    def test_rate_rejects_float(self):
        with pytest.raises(MoneyError, match="float"):
            Money.from_naira("100").apply_rate(7.5)

    def test_zero_rate_yields_zero(self):
        assert Money.from_naira("99999").apply_rate(Decimal("0")).kobo == 0


class TestFormatting:
    def test_whole_naira_has_no_decimals(self):
        assert Money.from_naira("64500").format() == "₦64,500"

    def test_kobo_shown_when_present(self):
        assert Money.from_naira("64500.50").format() == "₦64,500.50"

    def test_thousands_separators(self):
        assert Money.from_naira("1250000").format() == "₦1,250,000"

    def test_negative(self):
        assert (Money.zero() - Money.from_naira("500")).format() == "-₦500"

    def test_spoken_form_for_tts(self):
        # TTS is charged per character and is slow; keep it short and unambiguous.
        assert Money.from_naira("64500").spoken() == "64,500 naira"

    def test_spoken_keeps_the_sign(self):
        # A refund/discount line read aloud as a positive amount misstates the invoice.
        assert Money.from_naira("-5").spoken() == "minus 5 naira"
        assert (Money.zero() - Money.from_naira("500")).spoken() == "minus 500 naira"

    def test_spoken_zero(self):
        assert Money.zero().spoken() == "0 naira"


class TestImmutability:
    def test_field_cannot_be_reassigned(self):
        m = Money.from_naira("10")
        with pytest.raises(MoneyError, match="immutable"):
            m.kobo = 999  # type: ignore[misc]
        assert m.kobo == 1000  # unchanged

    def test_field_cannot_be_deleted(self):
        m = Money.from_naira("10")
        with pytest.raises(MoneyError, match="immutable"):
            del m.kobo  # type: ignore[misc]

    def test_new_attributes_cannot_be_added(self):
        m = Money.from_naira("10")
        with pytest.raises(MoneyError):
            m.note = "tampered"  # type: ignore[attr-defined]


class TestEquality:
    def test_equal_amounts_are_equal(self):
        assert Money.from_naira("10") == Money.from_naira("10.00")

    def test_ordering(self):
        assert Money.from_naira("9") < Money.from_naira("10")

    def test_money_is_hashable(self):
        assert len({Money.from_naira("1"), Money.from_naira("1")}) == 1
