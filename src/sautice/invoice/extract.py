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
from dataclasses import dataclass, field

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


def heuristic_extract(transcript: str) -> Intent:
    text = transcript.strip()

    # 1. Pull a trailing customer clause off the end first, so it is not parsed as
    #    part of the last line item.
    customer = ""
    m = re.search(r"\bfor\s+(?:customer|client)\s+(.+?)\s*[.?!]*\s*$", text, re.I)
    if m:
        customer = m.group(1).strip(" .,")
        text = text[: m.start()]
    else:
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
    m = re.search(r"\b((?:net\s+\d+|\d+\s*days?|\d+\s*weeks?|end of (?:the )?month|"
                  r"on delivery|cash|upfront|immediately)\b.*)$", text, re.I)
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
        # leading number words
        m = re.match(r"^\s*((?:\w+[\s-]*){1,3}?)\s+(?=" + _UNITS + r"|of\b|\w)", seg, re.I)
        m2 = re.match(r"^\s*([a-z]+(?:[\s-][a-z]+)?)\s+", seg, re.I)
        if m2 and _looks_like_number_word(m2.group(1)):
            qty = m2.group(1).strip()
            seg = seg[m2.end():]

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


def _looks_like_number_word(s: str) -> bool:
    return all(w in _NUMWORDS for w in s.lower().replace("-", " ").split())
