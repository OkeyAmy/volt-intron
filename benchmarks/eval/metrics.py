"""Frozen WER/CER scoring.

Ported and trimmed from Intron-Multimodal-Benchmarking/scripts/evaluations.py.

Policy: normalization is locked here, before any provider score is produced.
Two schemes per pair:
  - "basic": light cleanup (case, punctuation noise, filler words).
  - "norm":  whisper-normalizer (EnglishTextNormalizer for english,
             BasicTextNormalizer(remove_diacritics) for the rest).
Reported headline is always "norm"; "basic" is secondary context.
"""
from __future__ import annotations

import math
import re
import string

import jiwer

_INAUDIBLE_TAGS = [
    "[music] [inaudible]", "(inaudible) ", "[inaudible)", "(inaudible]",
    "[Inaudible].", "[music]", "[INAUDIBLE]", " [Inaudible]", "(Inaudible).",
    "[Inaudible] ", "[silence]", "[Silence]", "[inaudible] ", "in aduible",
    "(inaudible)", "(Inaudible)", "[Inaudible]", "Inaudible", "[inaudible]",
    "[inaudable]", "[Inaudible]", "Inaudable ", "Blank ", "inaudible",
    "Inaudible ", "(audio is empty)", "noise", "(noise)", "[noise]", "Blank",
]
_INAUDIBLE_RX = re.compile(
    "|".join(re.escape(t) for t in _INAUDIBLE_TAGS), re.I
)
_FILLER_WORDS = {
    "ah", "blah", "eh", "hmm", "huh", "hum", "mmhmm", "mm", "oh", "ohh",
    "uh", "uhhuh", "umhum", "uhhum", "um",
}
_TRANSLATOR = str.maketrans("", "", string.punctuation)
_GUARD = "abcxyz"  # jiwer needs non-empty strings; matches reference repo

_WHISPER = None


def _normalizers():
    global _WHISPER
    if _WHISPER is None:
        from whisper_normalizer.basic import BasicTextNormalizer
        from whisper_normalizer.english import (
            EnglishNumberNormalizer,
            EnglishTextNormalizer,
        )

        _WHISPER = (EnglishNumberNormalizer(), EnglishTextNormalizer, BasicTextNormalizer)
    return _WHISPER


def strip_inaudible(text: str) -> str:
    text = _INAUDIBLE_RX.sub(" ", text)
    text = text.replace("[", " ").replace("]", " ")
    return re.sub(r"\s+", " ", text).strip()


def _clean_filler(text: str) -> str:
    tokens = re.findall(r"\b\w+\b", text)
    return " ".join(t for t in tokens if t.lower() not in _FILLER_WORDS)


def clean_basic(text: str) -> str:
    """Light cleanup shared by both schemes (case, punctuation, fillers)."""
    text = _clean_filler(text)
    text = re.sub(r"\s\s+", " ", text).strip()
    text = text.replace(">", "").replace("\t", " ").replace("\n", "")
    text = text.lower()
    text = (
        text.replace(" comma,", ",")
        .replace(" koma,", " ")
        .replace(" coma,", ",")
        .replace(" comma", " ")
        .replace(" full stop.", ".")
        .replace(" full stop", ".")
        .replace(",.", ".")
        .replace(",,", ",")
        .strip()
    )
    text = " ".join(text.split())
    return re.sub(r"[^a-zA-Z0-9\s\.\,\-\?\:\'\/\(\)\[\]\+\%]", "", text)


def clean_multilingual(text: str, remove_diacritics: bool = True) -> str:
    nn, _en, BasicTextNormalizer = _normalizers()
    text = nn(text)
    text = (
        text.replace(" comma,", ",")
        .replace(" koma,", " ")
        .replace(" coma,", ",")
        .replace(" comma", " ")
        .replace(" full stop.", ".")
        .replace(" full stop", ".")
        .replace(",.", ".")
        .replace(",,", ",")
        .replace(":", " ")
        .replace(";", " ")
        .replace("?", " ")
        .replace("!", " ")
        .replace("(", " ")
        .replace(")", " ")
        .replace("[", " ")
        .replace("]", " ")
        .replace(",", " ")
        .replace(".", " ")
        .strip()
    )
    text = " ".join(text.split())
    return BasicTextNormalizer(remove_diacritics=remove_diacritics)(text)


def normalize_pair(ref: str, hyp: str, language: str, scheme: str = "norm"):
    """Return (norm_ref, norm_hyp) under the locked scheme."""
    is_en = (language or "").lower() in ("english", "en")
    r = strip_inaudible(ref)
    h = strip_inaudible(hyp)
    if scheme == "basic":
        if is_en:
            cr, ch = clean_basic(r), clean_basic(h)
            return cr.replace(",", "").replace(".", ""), ch.replace(",", "").replace(".", "")
        return clean_multilingual(r), clean_multilingual(h)
    nn, EnglishTextNormalizer, BasicTextNormalizer = _normalizers()
    if is_en:
        en = EnglishTextNormalizer()
        cr, ch = nn(r), nn(h)
        return en(cr) or _GUARD, en(ch) or _GUARD
    cr, ch = clean_multilingual(r), clean_multilingual(h)
    return cr or _GUARD, ch or _GUARD


def _guard_empty(s: str) -> str:
    return s if s.strip() else _GUARD


def cell_metrics(ref: str, hyp: str, language: str) -> dict:
    """Per-cell WER/CER under both schemes; guards empty pairs.

    Also returns the norm-scheme error-type counts (insertions/deletions/
    substitutions from jiwer.process_words) and a consistency flag proving the
    stored WER equals (S+D+I)/N, so every published number is independently
    re-derivable from the raw hypothesis.
    """
    out = {}
    for scheme in ("norm", "basic"):
        nr, nh = normalize_pair(ref, hyp, language, scheme)
        out[f"{scheme}_wer"] = jiwer.wer(_guard_empty(nr), _guard_empty(nh))
        out[f"{scheme}_cer"] = jiwer.cer(_guard_empty(nr), _guard_empty(nh))
    nr, nh = normalize_pair(ref, hyp, language, "norm")
    w = jiwer.process_words(_guard_empty(nr), _guard_empty(nh))
    n_ref = w.substitutions + w.deletions + w.insertions + w.hits
    out["norm_ins"] = w.insertions
    out["norm_del"] = w.deletions
    out["norm_sub"] = w.substitutions
    out["norm_hits"] = w.hits
    out["norm_n_ref"] = n_ref
    out["norm_wer_consistent"] = (
        n_ref > 0
        and abs((w.insertions + w.deletions + w.substitutions) / n_ref
                - out["norm_wer"]) < 1e-9
    )
    return out


# --- aggregation helpers ---------------------------------------------------

def t_crit_975(n: int) -> float:
    """Two-sided 95% t critical value (dependency-free; 1.96 beyond n=30)."""
    if n <= 1:
        return math.nan
    if n > 30:
        return 1.96
    table = {
        2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447,
        8: 2.365, 9: 2.306, 10: 2.262, 11: 2.228, 12: 2.201, 13: 2.179,
        14: 2.160, 15: 2.145, 16: 2.131, 17: 2.120, 18: 2.110, 19: 2.101,
        20: 2.093, 21: 2.086, 22: 2.080, 23: 2.074, 24: 2.069, 25: 2.064,
        26: 2.060, 27: 2.056, 28: 2.052, 29: 2.048, 30: 2.045,
    }
    return table.get(n, 1.96)


def summarize(values: list[float]) -> dict:
    """mean / median / q25-q75 / n / ci95 / sd over non-NaN scores."""
    import statistics

    vals = [v for v in values if v is not None and not math.isnan(v)]
    n = len(vals)
    if n == 0:
        return {"mean": None, "n": 0, "ci95": None, "sd": None,
                "median": None, "q25": None, "q75": None}
    mean = sum(vals) / n
    sd = (sum((v - mean) ** 2 for v in vals) / n) ** 0.5 if n > 1 else 0.0
    ci = t_crit_975(n) * sd / math.sqrt(n) if n > 1 else None
    if n == 1:
        med = q25 = q75 = vals[0]
    else:
        med = statistics.median(vals)
        q25 = statistics.quantiles(vals, n=4, method="inclusive")[0]
        q75 = statistics.quantiles(vals, n=4, method="inclusive")[2]
    return {
        "mean": round(mean, 4), "n": n, "ci95": round(ci, 4) if ci else None,
        "sd": round(sd, 4), "median": round(med, 4),
        "q25": round(q25, 4), "q75": round(q75, 4),
    }