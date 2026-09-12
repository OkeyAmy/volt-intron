"""Reading spoken Nigerian money, quantities, rates and payment terms.

Design rule: this parser is allowed to say "I cannot tell". It is not allowed to
guess. At ~35% word error rate the transcript is often wrong, so a reading that
looks plausible is not the same as a reading that is right. Every genuinely
ambiguous form returns all its candidates and forces the agent to ask.

Scope is deliberately narrow and fully tested: English and Pidgin money forms plus
the trader shorthands actually used in Nigerian commerce. Anything outside the
grammar returns no candidates rather than a plausible-looking number.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Iterable

from sautice.core.money import Money

# --- lexicon ---------------------------------------------------------------
UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
        "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
SCALES = {"hundred": 100, "thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}
EXTRA_QUANTITY = {"a dozen": 12, "dozen": 12, "a pair": 2, "pair": 2}

_CURRENCY = re.compile(r"[₦]|\bN(?=[\d,])|\bnaira\b", re.I)
_NOISE = re.compile(r"\b(?:about|around|like|say|abeg|make|am|each|per|only|just|plus)\b", re.I)


@dataclass(frozen=True)
class Reading:
    """One or more candidate values. More than one means the agent must ask."""
    candidates: tuple = ()
    note: str = ""
    _kind: str = field(default="amount", repr=False)

    @property
    def is_ambiguous(self) -> bool:
        return len(self.candidates) > 1

    @property
    def value_or_none(self):
        return self.candidates[0] if len(self.candidates) == 1 else None

    @property
    def value(self):
        if len(self.candidates) == 1:
            return self.candidates[0]
        if not self.candidates:
            raise ValueError(f"no readable {self._kind} in the text")
        raise ValueError(f"{self._kind} is ambiguous: {self.note}")


def _clean(text: str) -> str:
    t = text.lower().strip()
    t = _NOISE.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip(" .,")


def _words_to_int(tokens: list[str]) -> int | None:
    """Standard English number words. Returns None if the token run isn't a number."""
    if not tokens:
        return None
    total, current, seen = 0, 0, False
    for tok in tokens:
        if tok == "and":
            continue
        if tok in UNITS:
            current += UNITS[tok]; seen = True
        elif tok in TENS:
            current += TENS[tok]; seen = True
        elif tok in SCALES:
            if not seen and SCALES[tok] >= 1000:
                return None
            scale = SCALES[tok]
            if scale == 100:
                current = (current or 1) * 100
            else:
                total += (current or 1) * scale
                current = 0
            seen = True
        else:
            return None
    return total + current if seen else None


def _digits(text: str) -> Decimal | None:
    m = re.fullmatch(r"(\d[\d,]*)(?:\.(\d+))?", text.strip())
    if not m:
        return None
    whole = m.group(1).replace(",", "")
    return Decimal(f"{whole}.{m.group(2)}") if m.group(2) else Decimal(whole)


def _money(value: Decimal | int) -> Money:
    return Money.from_naira(Decimal(value).quantize(Decimal("0.01")))


# --- amounts ---------------------------------------------------------------
def read_amount(text: str) -> Reading:
    raw = text.strip()
    had_currency = bool(_CURRENCY.search(raw))
    t = _clean(_CURRENCY.sub(" ", raw))
    if not t:
        return Reading((), "nothing to read", "amount")

    # 12.5k / 500k / 1.5m
    m = re.fullmatch(r"([\d.,]+)\s*([km])\b", t, re.I)
    if m and (d := _digits(m.group(1))) is not None:
        mult = 1_000 if m.group(2).lower() == "k" else 1_000_000
        return Reading((_money(d * mult),), "", "amount")

    # bare digits
    if (d := _digits(t)) is not None:
        return Reading((_money(d),), "", "amount")

    tokens = t.replace("-", " ").split()

    # explicit scale word present => the magnitude is stated, not inferred
    if any(tok in SCALES for tok in tokens):
        n = _words_to_int(tokens)
        if n is not None:
            return Reading((_money(n),), "", "amount")

    # Trader shorthand: "twelve-five" = 12,500.
    # Only a unit or teen can open this form. A tens word compounds instead —
    # "twenty five" is the number 25, not 20,500 — so TENS must not match here.
    if len(tokens) == 2 and tokens[0] in UNITS and tokens[1] in UNITS:
        first, second = UNITS[tokens[0]], UNITS[tokens[1]]
        if first >= 1 and 1 <= second <= 9 and "-" in t:
            return Reading((_money(first * 1000 + second * 100),), "", "amount")

    n = _words_to_int(tokens)
    if n is None:
        return Reading((), f"could not read an amount from {text!r}", "amount")

    # "twelve five" (no hyphen) and "two fifty": the magnitude was never said.
    # Again, only a unit/teen opener — "twenty five" falls through to plain 25.
    if len(tokens) == 2:
        a, b = tokens
        if a in UNITS and b in UNITS and 1 <= UNITS[b] <= 9:
            return Reading((_money(UNITS[a] * 1000 + UNITS[b] * 100),), "", "amount")
        if a in UNITS and b in TENS:
            first = UNITS[a]
            cands = (_money(first * 100 + TENS[b]),
                     _money(first * 1000 + TENS[b] * 10),
                     _money((first * 100 + TENS[b]) * 1000))
            return Reading(cands, f"could mean {', '.join(c.format() for c in cands)}", "amount")

    if had_currency or n >= 1000:
        return Reading((_money(n),), "", "amount")

    # A bare small number in a money slot: naira, or thousands of naira?
    return Reading((_money(n), _money(n * 1000)),
                   f"could mean ₦{n:,} or ₦{n * 1000:,}", "amount")


# --- quantities ------------------------------------------------------------
def read_quantity(text: str) -> Reading:
    t = _clean(text)
    for phrase, val in EXTRA_QUANTITY.items():
        if phrase in t:
            return Reading((val,), "", "quantity")
    m = re.search(r"\b(\d+)\b", t)
    if m:
        if re.search(r"\b\d+\.\d+\b", t):
            return Reading((), "quantities must be whole", "quantity")
        n = int(m.group(1))
        return Reading((n,), "", "quantity") if n > 0 else Reading((), "quantity must be at least 1", "quantity")
    words = [w for w in t.replace("-", " ").split() if w in UNITS or w in TENS or w in SCALES or w == "and"]
    n = _words_to_int(words)
    if n is None or n <= 0:
        return Reading((), f"could not read a quantity from {text!r}", "quantity")
    return Reading((n,), "", "quantity")


# --- rates -----------------------------------------------------------------
NIGERIA_VAT_RATE = Decimal("7.5")   # Nigeria Tax Act 2025, standard rate, in force 2026-01-01

def read_percent(text: str) -> Decimal | None:
    t = _clean(text)
    m = re.search(r"([\d.]+)\s*(?:%|percent)", t)
    if m:
        return Decimal(m.group(1))
    m = re.search(r"([a-z ]+?)\s*(?:%|percent)\b", t)
    if m:
        toks = m.group(1).split()
        if "point" in toks:
            i = toks.index("point")
            whole, frac = _words_to_int(toks[:i]), _words_to_int(toks[i + 1:])
            if whole is not None and frac is not None:
                return Decimal(f"{whole}.{frac}")
        n = _words_to_int(toks)
        if n is not None:
            return Decimal(n)
    if re.search(r"\bvat\b", t):
        return NIGERIA_VAT_RATE
    return None


# --- payment terms ---------------------------------------------------------
def read_term_days(text: str) -> int | str | None:
    t = _clean(text)
    if re.search(r"\bend of (the )?month\b|\bmonth end\b", t):
        return "end_of_month"
    if re.search(r"\b(on delivery|cash|now|immediately|upfront)\b", t):
        return 0
    m = re.search(r"\b(\d+)\s*(day|week|month)s?\b", t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return n * {"day": 1, "week": 7, "month": 30}[unit]
    m = re.search(r"\b([a-z ]+?)\s*(day|week|month)s?\b", t)
    if m:
        n = _words_to_int([w for w in m.group(1).split() if w != "a"]) or (1 if m.group(1).strip() in {"a", ""} else None)
        if n is not None:
            return n * {"day": 1, "week": 7, "month": 30}[m.group(2)]
    return None
