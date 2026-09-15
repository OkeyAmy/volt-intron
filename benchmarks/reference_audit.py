"""Reference-quality audit via cross-provider consensus (industry standard).

AssemblyAI: "bad reference transcripts are the #1 cause of misleading WER";
Indian-ASR-Bench uses a cross-model consensus classifier to flag
reference/audio mismatches from agreement patterns alone, without human review.

Method (same idea, applied to any set of providers):
  - If providers agree closely with EACH OTHER (median pairwise normalized WER
    low) but all disagree with the reference (ref WER high), the reference
    transcript is a strong mismatch candidate for that audio.
  - Empty hypotheses and single-provider outliers are flagged independently.

Consensus is only counted on `ok` cells; failed/empty cells are flagged, not
used as evidence. Flags are advisory — they point a human at the clip.

Usage:
    uv run python -m benchmarks.reference_audit --tag pilot

Reads the committed per-provider transcripts written by benchmarks.run and
writes `outputs/<tag>/ref_audit.md` + `ref_audit.tsv`.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path

from .eval import metrics as met
from .run import OUTPUTS, TRANS_COLUMNS

PAIRWISE_CONSENSUS_MAX = 0.15   # models agree with each other below this WER
REF_DIVERGENCE_MIN = 0.40       # ...and disagree with the reference above this


def _wer(a: str, b: str, language: str) -> float:
    na, nb = met.normalize_pair(a, b, language, "norm")
    if not na.strip() or not nb.strip():
        return 1.0
    return float(met.jiwer.wer(met._guard_empty(na), met._guard_empty(nb)))


def audit(tag: str) -> dict:
    trans_dir = OUTPUTS / tag / "transcripts"
    prov_paths = sorted(trans_dir.glob("*.tsv")) if trans_dir.exists() else []
    if not prov_paths:
        print(f"[-] no transcripts for tag '{tag}' (run benchmarks.run first)")
        return {}

    cells: dict[tuple[str, str], dict] = {}
    for p in prov_paths:
        prov = p.stem
        with open(p, newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                cells[(prov, row["id"])] = {**row, "provider": prov}

    by_id: dict[str, dict] = {}
    for (prov, cid), row in cells.items():
        by_id.setdefault(cid, {})[prov] = row

    report_rows: list[dict] = []
    for cid in sorted(by_id):
        provs = by_id[cid]
        langs = {r["language"] for r in provs.values() if r["language"]}
        language = sorted(langs)[0] if len(langs) == 1 else "english"
        ref = next((r["text_ref"] for r in provs.values() if r["text_ref"]), "")
        hys = {p: r["text_hyp"] for p, r in provs.items() if r["text_hyp"]}
        ok_provs = [p for p, r in provs.items() if r["ok"] == "True"]
        src = next((r["source"] for r in provs.values()), "")

        pair_wer = [
            _wer(hys[a], hys[b], language)
            for i, a in enumerate(sorted(hys))
            for b in sorted(hys)[i + 1:]
            if a in ok_provs and b in ok_provs
        ]
        ref_wer = {p: r.get("norm_wer") for p, r in provs.items()}

        flags: list[str] = []
        if not hys:
            flags.append("empty_hypothesis")
        elif len(ok_provs) >= 2 and pair_wer:
            med_pair = statistics.median(pair_wer)
            med_ref = _median_ref(provs)
            if med_pair <= PAIRWISE_CONSENSUS_MAX and med_ref >= REF_DIVERGENCE_MIN:
                flags.append("REF_MISMATCH_CANDIDATE")
            if med_pair > 0.5:
                flags.append("low_cross_provider_agreement")
        # single-provider outlier (>=0.3 worse than the median provider)
        vals = [float(v) for v in ref_wer.values() if v not in (None, "")]
        if len(vals) >= 2:
            med = statistics.median(vals)
            for p, v in ref_wer.items():
                if v not in (None, "") and float(v) - med >= 0.3:
                    flags.append(f"outlier:{p}")

        report_rows.append({
            "id": cid, "source": src, "language": language,
            "n_providers": len(provs), "n_ok": len(ok_provs),
            "median_pairwise_wer": round(statistics.median(pair_wer), 3) if pair_wer else "",
            "median_ref_wer": round(_median_ref(provs), 3) if _median_ref(provs) is not None else "",
            "flags": ",".join(flags),
            "text_ref": ref,
        })

    # write tsv + md
    (OUTPUTS / tag).mkdir(parents=True, exist_ok=True)
    tsv = OUTPUTS / tag / "ref_audit.tsv"
    with open(tsv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(report_rows[0].keys()), delimiter="\t")
        w.writeheader()
        w.writerows(report_rows)

    flagged = [r for r in report_rows if r["flags"]]
    mism = [r for r in report_rows if "REF_MISMATCH_CANDIDATE" in r["flags"]]
    lines = [f"# Reference audit — `{tag}`", "",
             "Consensus classifier: when providers agree with each other "
             "(median pairwise WER ≤ 0.15) but all disagree with the reference "
             "(median ref WER ≥ 0.40), the reference/audio pair is a mismatch "
             "candidate — flags never overrule human review.",
             f"- total cells: {len(report_rows)}",
             f"- flagged: {len(flagged)}",
             f"- REF_MISMATCH_CANDIDATE: {len(mism)}", ""]
    if mism:
        lines.append("| id | source | pair WER | ref WER | reference |")
        lines.append("|---|---|---|---|---|")
        for r in mism:
            lines.append(f"| {r['id']} | {r['source']} | {r['median_pairwise_wer']} | "
                         f"{r['median_ref_wer']} | {r['text_ref'][:70]} |")
        lines.append("")
    lines.append("Full per-cell flags: `ref_audit.tsv`.")
    (OUTPUTS / tag / "ref_audit.md").write_text("\n".join(lines) + "\n")
    print(f"[audit] {len(report_rows)} cells, {len(flagged)} flagged, "
          f"{len(mism)} REF_MISMATCH_CANDIDATE -> {OUTPUTS / tag / 'ref_audit.md'}")
    return {"total": len(report_rows), "flagged": len(flagged),
            "ref_mismatch_candidates": len(mism)}


def _median_ref(provs: dict) -> float | None:
    vals = [float(r["norm_wer"]) for r in provs.values()
            if r.get("norm_wer") not in (None, "") and r["ok"] == "True"]
    return statistics.median(vals) if vals else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="pilot")
    args = ap.parse_args()
    audit(args.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())