"""Monetary amounts as integer kobo.

Money never touches a binary float. A float cannot represent 0.1 exactly, so
float arithmetic silently loses fractions of a kobo; over a multi-line invoice
that produces a total the business did not agree to. Every amount here is an
integer count of kobo, and every conversion goes through Decimal.

100 kobo = 1 naira.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable

KOBO_PER_NAIRA = 100


class MoneyError(ValueError):
    """Raised when a value cannot be represented as an exact kobo amount."""


def _reject_float(value: object, what: str) -> None:
    if isinstance(value, float):
        raise MoneyError(
            f"{what} was given as a float ({value!r}). Floats lose fractions of a kobo; "
            "pass a str, int or Decimal instead."
        )


class Money:
    """An exact amount in kobo. Immutable."""

    __slots__ = ("kobo",)

    def __init__(self, kobo: int) -> None:
        if isinstance(kobo, bool) or not isinstance(kobo, int):
            raise MoneyError(f"kobo must be an int, got {type(kobo).__name__}")
        object.__setattr__(self, "kobo", kobo)

    # --- immutability -----------------------------------------------------
    # Without these, `m.kobo = 999` silently succeeds and breaks the hash/equality
    # contract the class advertises. Construction uses object.__setattr__ above,
    # which bypasses this guard by design.
    def __setattr__(self, name: str, value: object) -> None:
        raise MoneyError("Money is immutable; build a new one instead of assigning to it")

    def __delattr__(self, name: str) -> None:
        raise MoneyError("Money is immutable; its fields cannot be deleted")

    # --- construction -----------------------------------------------------
    @classmethod
    def zero(cls) -> "Money":
        return cls(0)

    @classmethod
    def from_naira(cls, amount: str | int | Decimal) -> "Money":
        _reject_float(amount, "naira amount")
        try:
            dec = Decimal(amount)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise MoneyError(f"cannot read {amount!r} as an amount of naira") from exc
        if dec != dec.quantize(Decimal("0.01")):
            raise MoneyError(
                f"{amount!r} is finer than one kobo; naira amounts carry at most 2 decimal places"
            )
        return cls(int(dec.scaleb(2)))

    @classmethod
    def from_kobo(cls, kobo: int) -> "Money":
        return cls(kobo)

    @classmethod
    def sum(cls, items: Iterable["Money"]) -> "Money":
        return cls(sum(m.kobo for m in items))

    # --- arithmetic -------------------------------------------------------
    def __add__(self, other: "Money") -> "Money":
        return Money(self.kobo + other.kobo)

    def __sub__(self, other: "Money") -> "Money":
        return Money(self.kobo - other.kobo)

    def __mul__(self, quantity: int) -> "Money":
        """Multiply by a whole quantity. Fractional quantities are not a thing you sell."""
        _reject_float(quantity, "quantity")
        if isinstance(quantity, bool) or not isinstance(quantity, int):
            raise MoneyError(f"quantity must be a whole number, got {type(quantity).__name__}")
        return Money(self.kobo * quantity)

    __rmul__ = __mul__

    def apply_rate(self, percent: Decimal) -> "Money":
        """Percentage of this amount, rounded half-up to the nearest kobo.

        Half-up is what a cash till does and what an invoice reader expects.
        Python's default (banker's rounding) would round 2.5 kobo down to 2.
        """
        _reject_float(percent, "rate")
        if not isinstance(percent, (Decimal, int)):
            raise MoneyError(f"rate must be a Decimal, got {type(percent).__name__}")
        exact = Decimal(self.kobo) * Decimal(percent) / Decimal(100)
        return Money(int(exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP)))

    def __neg__(self) -> "Money":
        return Money(-self.kobo)

    # --- presentation -----------------------------------------------------
    @property
    def naira(self) -> Decimal:
        return (Decimal(self.kobo) / KOBO_PER_NAIRA).quantize(Decimal("0.01"))

    def format(self) -> str:
        """Human-readable. Kobo are shown only when non-zero, as on a real invoice."""
        sign = "-" if self.kobo < 0 else ""
        whole, kobo = divmod(abs(self.kobo), KOBO_PER_NAIRA)
        body = f"{whole:,}" if kobo == 0 else f"{whole:,}.{kobo:02d}"
        return f"{sign}₦{body}"

    def spoken(self) -> str:
        """Short form for TTS. Intron charges per character and is slow, so keep it tight.

        The sign is spoken, not dropped: a refund or discount line read aloud as a
        positive amount would misstate the invoice.
        """
        sign = "minus " if self.kobo < 0 else ""
        return f"{sign}{self.format().lstrip('-₦')} naira"

    # --- comparison -------------------------------------------------------
    def __eq__(self, other: object) -> bool:
        return isinstance(other, Money) and self.kobo == other.kobo

    def __lt__(self, other: "Money") -> bool:
        return self.kobo < other.kobo

    def __le__(self, other: "Money") -> bool:
        return self.kobo <= other.kobo

    def __gt__(self, other: "Money") -> bool:
        return self.kobo > other.kobo

    def __ge__(self, other: "Money") -> bool:
        return self.kobo >= other.kobo

    def __hash__(self) -> int:
        return hash(("Money", self.kobo))

    def __repr__(self) -> str:
        return f"Money({self.kobo} kobo = {self.format()})"
