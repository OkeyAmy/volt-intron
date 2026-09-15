"""Heuristic transcript -> intent.

This is the deterministic fallback used when no LLM extractor is configured. It is
deliberately conservative: it recognises the common shapes of a spoken sale and
leaves anything it is unsure about empty, so the executor turns the gap into a
question. It never invents a quantity, price, or name.

Shape it understands:
    "<qty> <unit?> (of)? <product> at|@|for <price> (each)?" , joined by
    "and" / "," / "plus" / "also", with an optional trailing
    "for (customer) <name>" and "<terms>".
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from sautice.nlp.naira import read_amount

# Polite openers said before the customer's name ("Abeg, Adebayo Stores buy ...").
# Stripped only at the very start, so they can never eat a name or number mid-sentence.
_LEAD_FILLER = re.compile(
    r"^\s*(?:(?:abeg|biko|oya|please|kindly|jowo|jọ̀wọ́|ẹ jọ̀ọ́|e jo|don allah|hello|oga|madam|sir|"
    r"good (?:morning|afternoon|evening))[\s,.!]+)+",
    re.I,
)
# Purchase verbs that follow a leading customer name, including common Pidgin forms.
_SUBJECT_VERBS = (
    r"(?:bought|buys?|wants?|ordered|orders?|needs?|took|takes?|purchased|purchases?|"
    r"is buying|would like|collected|collects?|carried|"
    r"(?:wan|don|go|dey|come)\s+(?:buy|take|collect|carry|order|get))"
)
_NUMWORD = (r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
            r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|a)")
# Payment terms, with an optional spoken lead-in ("pay in", "make dem pay in", "due in")
# so the lead-in is not left behind as a bogus product line.
_TERMS = re.compile(
    r"\b((?:(?:and\s+)?(?:make\s+(?:dem|dey|him|am|e|she|he|they|them)\s+)?"
    r"(?:pay(?:ment)?|due)\s+(?:in|for|within|after|on|by)\s+)?"
    r"(?:net\s+\d+|\d+\s*days?|\d+\s*weeks?|"
    + _NUMWORD + r"(?:[\s-]+" + _NUMWORD + r")*\s+(?:days?|weeks?)|"
    r"end of (?:the )?month|month end|on delivery|cash|upfront|immediately)\b.*)$",
    re.I,
)
_EACH = re.compile(r"^(.+?)\s+(?:each|apiece|per\s+\w+)$", re.I)

_FILLER = re.compile(
    r"\b(please|kindly|good (morning|afternoon|evening)|record|create|make|raise|"
    r"an?|the|invoice|receipt|bill|for me|i want to|i want|let me|okay|ok|so|"
    r"abeg|biko|oya)\b",
    re.I,
)
_UNITS = r"(?:bags?|bag|lengths?|buckets?|tins?|sheets?|trips?|rolls?|pieces?|pcs?|units?|pcs)"
_SPLIT = re.compile(r"\s*(?:,|\band\b|\bplus\b|\balso\b|\bthen\b)\s+", re.I)


@dataclass
class Line:
    qty_text: str = ""
    product_query: str = ""
    price_text: str = ""


@dataclass
class Intent:
    customer_query: str = ""
    terms_text: str = ""
    lines: list[Line] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "customer_query": self.customer_query,
            "terms_text": self.terms_text,
            "lines": [{"qty_text": l.qty_text, "product_query": l.product_query, "price_text": l.price_text}
                      for l in self.lines],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Intent":
        return cls(
            customer_query=str(d.get("customer_query", "")),
            terms_text=str(d.get("terms_text", "")),
            lines=[Line(str(l.get("qty_text", "")), str(l.get("product_query", "")), str(l.get("price_text", "")))
                   for l in d.get("lines", [])],
        )


def _strip_filler(t: str) -> str:
    return re.sub(r"\s+", " ", _FILLER.sub(" ", t)).strip(" .,")


def _bare_price(seg: str) -> str:
    """The price in a segment that is ONLY a price ("twelve-five each", "12,500 naira").

    Needs an explicit price marker (each / per / apiece / naira / ₦) and must read as
    an amount, so a plain second item ("two buckets of paint") is never taken as one.
    """
    m = _EACH.match(seg)
    core = m.group(1) if m else seg
    if not (m or re.search(r"₦|\bnaira\b", seg, re.I)):
        return ""
    core = re.sub(r"^\s*(?:na|for|at|@)\s+", "", core, flags=re.I).strip(" .,")
    return core if core and read_amount(core).candidates else ""


def heuristic_extract(transcript: str) -> Intent:
    text = unicodedata.normalize("NFC", transcript).strip()
    text = _LEAD_FILLER.sub("", text)

    customer = ""

    # 0. Leading subject: "<Name> bought/wants/ordered ... <rest>". Common phrasing
    #    where the customer opens the sentence rather than trailing it.
    m = re.match(
        r"^\s*([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s+" + _SUBJECT_VERBS + r"\b",
        text,
    )
    if m and not re.search(r"\d", m.group(1)):
        customer = m.group(1).strip(" .,")
        text = text[m.end():]

    # 1. Otherwise pull a trailing customer clause off the end, so it is not parsed
    #    as part of the last line item.
    if not customer:
        m = re.search(r"\bfor\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$", text, re.I)
        if m:
            customer = m.group(1).strip(" .,")
            text = text[: m.start()]
    if not customer:
        m = re.search(r"\bto\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$", text, re.I)
        if m:
            customer = m.group(1).strip(" .,")
            text = text[: m.start()]
    if not customer:
        # A trailing "for <Capitalised Name>" with no digit is a customer, not a
        # price ("... for Adebayo Stores"). A price would read "... for 12500".
        m = re.search(r"\bfor\s+([A-Z][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,4})\s*[.?!]*\s*$", text)
        if m and not re.search(r"\d", m.group(1)):
            customer = m.group(1).strip(" .,")
            text = text[: m.start()]

    # 2. Pull payment terms if stated.
    terms = ""
    m = _TERMS.search(text)
    if m:
        terms = m.group(1).strip(" .,")
        text = text[: m.start()]

    body = _strip_filler(text)
    body = re.sub(r"^\s*for\b\s*", "", body, flags=re.I)  # leftover "invoice FOR ..."
    if not body:
        return Intent(customer_query=customer, terms_text=terms, lines=[])

    lines: list[Line] = []
    for seg in _SPLIT.split(body):
        seg = seg.strip(" .,")
        if not seg:
            continue
        # "five bags of cement, twelve-five each": a price-only segment prices the
        # previous line when that line has none, instead of becoming a product.
        bare = _bare_price(seg)
        if bare and lines and not lines[-1].price_text:
            lines[-1].price_text = bare
            continue
        line = _parse_segment(seg)
        if line.product_query or line.qty_text or line.price_text:
            lines.append(line)

    return Intent(customer_query=customer, terms_text=terms, lines=lines)


def _parse_segment(seg: str) -> Line:
    price = ""
    # Price after "at"/"@" (preferred), or "for" when it is not the first word,
    # optional trailing "each/per ...". A leading "for" is a leftover connective,
    # not a price marker.
    m = re.search(r"\b(?:at|@)\s+(.+?)(?:\s+(?:each|per\b.*|apiece))?\s*$", seg, re.I)
    if not m:
        m = re.search(r"(?<=.)\bfor\s+(.+?)(?:\s+(?:each|per\b.*|apiece))?\s*$", seg, re.I)
    if m:
        price = m.group(1).strip(" .,")
        seg = seg[: m.start()].strip(" .,")

    qty = ""
    # leading digits
    m = re.match(r"^\s*(\d+)\b", seg)
    if m:
        qty = m.group(1)
        seg = seg[m.end():]
    else:
        # leading RUN of number words, stopping at the first non-number token
        # ("five bags" -> qty "five", leaving "bags ..."; "twenty five bags" -> "twenty five").
        toks = seg.split()
        run = 0
        for t in toks:
            if t.lower().replace("-", "") in _NUMWORDS:
                run += 1
            else:
                break
        if run:
            qty = " ".join(toks[:run])
            seg = " ".join(toks[run:])

    # strip a leading unit + optional "of"
    seg = re.sub(r"^\s*" + _UNITS + r"\b", "", seg, flags=re.I)
    seg = re.sub(r"^\s*of\b", "", seg, flags=re.I)
    product = re.sub(r"\s+", " ", seg).strip(" .,")

    return Line(qty_text=qty, product_query=product, price_text=price)


_NUMWORDS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "a", "couple",
    "dozen", "half",
}
