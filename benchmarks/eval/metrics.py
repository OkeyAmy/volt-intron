"""Frozen WER/CER scoring.

Ported and trimmed from Intron-Multimodal-Benchmarking/scripts/evaluations.py.

Policy: normalization is locked here, before any provider score is produced.
Three schemes per pair (all pure functions of ref/hyp/language):
  - "basic":     light cleanup (case, punctuation noise, filler words).
  - "norm":      whisper-normalizer (EnglishTextNormalizer for english,
                 BasicTextNormalizer(remove_diacritics) for the rest).
                 Frozen default: reported headline.
  - "norm_diac": same as norm but PRESERVES diacritics (tones) for non-English.
                 Reference: 2026 African-ASR literature (FER/TER, OpenWER) warns
                 that stripping tone diacritics hides phonological errors, so the
                 gap norm - norm_diac is reported as tone/diacritic-driven error.
                 For english both schemes are identical by construction.

The extra scheme is computed per cell but does not change the frozen headline.
Every published aggregate stays re-derivable from the published raw hypotheses.

Method version bumps when the scoring scheme changes; recorded in results.json
so every published number is pinned to the exact metric definition.
"""
from __future__ import annotations

import math
import re
import string

import jiwer

METRICS_VERSION = "2.0"

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


def clean_multilingual(text: str, remove_diacritics: bool = True,
                     preserve_marks: bool = False) -> str:
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
    return BasicTextNormalizer(remove_diacritics=remove_diacritics,
                               preserve_marks=preserve_marks)(text)


def normalize_pair(ref: str, hyp: str, language: str, scheme: str = "norm"):
    """Return (norm_ref, norm_hyp) under the locked scheme.

    scheme is one of "norm" | "norm_diac" | "basic". "norm_diac" differs from
    "norm" only by keeping diacritics (tone marks) for non-English text; english
    takes the identical path in both, so the two schemes converge for en."""
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
    if scheme == "norm_diac":
        # keep tone diacritics by preserving Unicode Mark chars, so tonal
        # differences are scored instead of being erased (FER/TER, OpenWER).
        cr = clean_multilingual(r, remove_diacritics=False, preserve_marks=True)
        ch = clean_multilingual(h, remove_diacritics=False, preserve_marks=True)
    else:
        cr = clean_multilingual(r, remove_diacritics=True)
        ch = clean_multilingual(h, remove_diacritics=True)
    return cr or _GUARD, ch or _GUARD


def _guard_empty(s: str) -> str:
    return s if s.strip() else _GUARD


def cell_metrics(ref: str, hyp: str, language: str) -> dict:
    """Per-cell WER/CER under all locked schemes; guards empty pairs.

    Also returns the norm-scheme error-type counts (insertions/deletions/
    substitutions from jiwer.process_words) and a consistency flag proving the
    stored WER equals (S+D+I)/N, so every published number is independently
    re-derivable from the raw hypothesis. The same consistency hold is emitted
    for the diacritics-preserving norm_diac scheme.
    """
    out = {}
    for scheme in ("norm", "norm_diac", "basic"):
        nr, nh = normalize_pair(ref, hyp, language, scheme)
        out[f"{scheme}_wer"] = jiwer.wer(_guard_empty(nr), _guard_empty(nh))
        out[f"{scheme}_cer"] = jiwer.cer(_guard_empty(nr), _guard_empty(nh))

    def _counts(scheme: str) -> tuple[int, int, int, int, int]:
        nr, nh = normalize_pair(ref, hyp, language, scheme)
        w = jiwer.process_words(_guard_empty(nr), _guard_empty(nh))
        # jiwer's WER denominator is the REFERENCE length = S + D + H (insertions
        # add only to the numerator: WER=(S+D+I)/N_ref).
        return (
            w.substitutions + w.deletions + w.hits,
            w.substitutions, w.deletions, w.insertions, w.hits,
        )

    n_ref, subs, dels, ins, hits = _counts("norm")
    out["norm_ins"] = ins
    out["norm_del"] = dels
    out["norm_sub"] = subs
    out["norm_hits"] = hits
    out["norm_n_ref"] = n_ref
    out["norm_wer_consistent"] = (
        n_ref > 0
        and abs((ins + dels + subs) / n_ref - out["norm_wer"]) < 1e-9
    )
    d_ref, d_sub, d_del, d_ins, _ = _counts("norm_diac")
    out["norm_diac_wer_consistent"] = (
        d_ref > 0
        and abs((d_ins + d_del + d_sub) / d_ref - out["norm_diac_wer"]) < 1e-9
    )
    return out


def macro_average(grouped: dict[str, dict]) -> dict:
    """Unweighted macro-average across groups (e.g. per-language means).

    Reporters of African multilingual ASR (WAXAL 2026, SimbaBench) headline a
    macro average so each language counts once regardless of clip counts; the
    utterance-pooled mean is reported separately as the sample mean."""
    means = [v["mean"] for v in grouped.values() if v.get("mean") is not None]
    if not means:
        return {"mean": None, "n_groups": 0}
    return {"mean": round(sum(means) / len(means), 4), "n_groups": len(means)}


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