"""Phase 3: orchestration - providers x cells, cached scoring, report.

Usage:
    uv run python -m benchmarks.run --providers intron_sahara --tag smoke --max-cells 12
    uv run python -m benchmarks.run --tag pilot            # all configured providers
    uv run python -m benchmarks.run --synthesize-tts       # materialize TTS clips first

Guarantees:
  - results cached per (provider, audio_hash); re-runs never re-spend credits
  - Intron spend estimated (0.44 credits/audio-s) and hard-stopped at --balance 200
  - per_cell.jsonl, results.json, and model-card report.md written to outputs/<tag>/
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

from .eval import metrics as met
from .eval import money_outcome as mo
from .providers import resolve_providers
from .providers.intron_sahara import CREDITS_PER_AUDIO_SEC

load_dotenv()

BENCH = Path(__file__).resolve().parent
DATA = BENCH / "data"
MANIFEST = DATA / "pilot_manifest.csv"
OUTPUTS = BENCH / "outputs"
CACHE = OUTPUTS / "cache"


def load_rows() -> list[dict]:
    with open(MANIFEST) as f:
        return list(csv.DictReader(f))


def audio_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()[:16]


def cache_key(provider: str, ahash: str) -> Path:
    return CACHE / f"{provider}_{ahash}.json"


def load_cached(provider: str, ahash: str) -> dict | None:
    p = cache_key(provider, ahash)
    if p.exists():
        return json.loads(p.read_text())
    return None


def store_cached(provider: str, ahash: str, data: dict) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_key(provider, ahash).write_text(json.dumps(data, ensure_ascii=False))


def estimate_credits(rows: list[dict]) -> float:
    return sum(float(r["duration"]) * CREDITS_PER_AUDIO_SEC for r in rows)


def run(args) -> tuple[list[dict], dict]:
    rows = load_rows()
    if args.max_cells:
        rows = rows[: args.max_cells]
    providers = resolve_providers(args.providers)
    if not providers:
        print("[-] no providers available (check env keys); nothing to do")
        return [], {"burn": 0.0, "fresh": 0, "cache_hits": 0}

    roster = mo.load_roster()
    scenarios = {s["id"]: s for s in mo.load_scenarios()["scenarios"]}

    n_audio = sum(1 for r in rows if not is_synthetic(r) and Path(r["audio_path"]).exists())
    est = estimate_credits([r for r in rows if not is_synthetic(r)])
    print(f"[run] cells={len(rows)} (human={n_audio}, synthetic={len(rows) - n_audio}) "
          f"est. <= {est:.0f} Intron credits (0.44/audio-s)")
    if est > args.cost_warn and args.balance:
        print(f"  !! est. spend {est:.0f} > warn {args.cost_warn}; pass --cost-warn to override")
        if est > args.balance - 200:
            print(f"  !! est. spend would push balance under 200 (balance={args.balance}); aborting")
            return []

    cells = []
    burn = 0.0
    fresh = 0
    cache_hits = 0
    for row in rows:
        if not Path(row["audio_path"]).exists():
            print(f"  [!] missing audio: {row['audio_path']} - skip")
            continue
        ah = audio_hash(row["audio_path"])
        is_syn = is_synthetic(row)
        for name, prov in providers.items():
            cached = None if args.fresh else load_cached(name, ah)
            if cached and cached.get("audio") == row["audio_path"]:
                repl = cached
                cache_hits += 1
                print(f"  [cache] {name} {row['id']}")
            else:
                if name == "intron_sahara" and not is_syn:
                    cost = float(row["duration"]) * CREDITS_PER_AUDIO_SEC
                    if args.balance and args.balance - burn - cost < 200:
                        print(f"  [stop] projected balance < 200 after {name}/{row['id']}; "
                              f"hard-stop active")
                        continue
                    burn += cost
                fresh += 1
                rep = prov.transcribe(row["audio_path"], row["language"],
                                      source=row["source"], timeout_s=args.timeout)
                repl = rep.to_dict()
                if repl.get("ok"):
                    store_cached(name, ah, repl)
                print(f"  [ok]   {name} {row['id']} {repl['ok']} "
                      f"{str(repl.get('error') or '')[:60]}")

            cell = {**row, **repl}
            cell["audio_hash"] = ah
            cell.update(met.cell_metrics(row["text_ref"], repl.get("text", ""), row["language"]))

            if row.get("scenario_id") in scenarios and row["scenario_id"]:
                cell["money"] = mo.score_scenario(
                    repl.get("text", ""), scenarios[row["scenario_id"]], roster)
            else:
                cell["money"] = mo.diagnose_transcript(repl.get("text", ""), roster)
            cells.append(cell)

    stats = {"burn": round(burn, 2), "fresh": fresh, "cache_hits": cache_hits}
    print(f"[run] done: {len(cells)} cells, est fresh Intron burn this run ~{burn:.1f} credits")
    return cells, stats


def is_synthetic(row: dict) -> bool:
    return row.get("source", "") == "synthetic"


def write_outputs(tag: str, cells: list[dict], rows: list[dict],
                  balance: float | None = None, run_cost: dict | None = None) -> dict:
    """Write merged per-tag outputs.

    Partial runs (a subset of providers) merge with any previous run under the
    same tag, keyed by (provider, audio_hash), so re-running one provider never
    erases another's cells. The cost ledger reflects the merged set.

    Transparency (industry standard): every raw hypothesis is published to
    outputs/<tag>/transcripts/<provider>.tsv so any number below is
    independently re-derivable from the AI's actual output."""
    out_dir = OUTPUTS / tag
    out_dir.mkdir(parents=True, exist_ok=True)

    per_tag = out_dir / "per_cell.jsonl"
    merged: dict[tuple[str, str], dict] = {}
    if per_tag.exists():
        for line in per_tag.read_text().splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            merged[(c["provider"], c["audio_hash"])] = c
    for c in cells:
        merged[(c["provider"], c["audio_hash"])] = c
    all_cells = []
    for c in merged.values():
        all_cells.append(_backfill_cell_metrics(c))

    with open(per_tag, "w") as f:
        for c in all_cells:
            f.write(json.dumps(c, ensure_ascii=False, default=str) + "\n")

    trans_dir = out_dir / "transcripts"
    write_transcripts(trans_dir, all_cells)

    summary = summarize(all_cells)
    cost = {
        "intron_est_credits_all_cells": round(
            sum(float(c["audio_sec"]) * CREDITS_PER_AUDIO_SEC
                for c in all_cells if c["provider"] == "intron_sahara"), 2),
        "audio_seconds_by_provider": {
            p: round(sum(float(c["audio_sec"]) for c in all_cells if c["provider"] == p), 2)
            for p in sorted({c["provider"] for c in all_cells})
        },
        "fresh_cells_this_run": (run_cost or {}).get("fresh", 0),
        "cache_hits_this_run": (run_cost or {}).get("cache_hits", 0),
        "est_fresh_intron_credits_this_run": (run_cost or {}).get("burn", 0.0),
        "balance_snapshot": balance,
    }
    results = {
        "tag": tag,
        "cells": len(all_cells),
        "providers": sorted({c["provider"] for c in all_cells}),
        "summary": summary,
        "cost": cost,
        "committed_rows": len(rows),
        "methodology": methodology(),
        "provider_snapshots": provider_snapshots(),
    }
    (out_dir / "results.json").write_text(json.dumps(results, indent=2, default=str))
    (out_dir / "cost.json").write_text(json.dumps(cost, indent=2))
    (out_dir / "report.md").write_text(render_report(tag, summary))
    print(f"[out] {out_dir} ({len(all_cells)} cells, {len({c['provider'] for c in all_cells})} providers)")
    return summary


def summarize(cells: list[dict]) -> dict:
    by_prov: dict = {}
    for c in cells:
        by_prov.setdefault(c["provider"], []).append(c)

    summary = {}
    for prov, cs in by_prov.items():
        human = [c for c in cs if not is_synthetic(c)]
        # Track 1 stays the open corpora only; our recordings are scored apart.
        corpus = [c for c in human if c.get("source") not in ("recorded", "codeswitch")]
        recorded = [c for c in human if c.get("source") == "recorded"]
        codeswitch = [c for c in human if c.get("source") == "codeswitch"]
        syn = [c for c in cs if is_synthetic(c)]
        cok = [c for c in corpus if c["ok"]]
        lbreak = _grouped([c for c in corpus], "language")
        lcer = _grouped([c for c in corpus], "language", "norm_cer")
        ldiac = _grouped([c for c in corpus], "language", "norm_diac_wer")
        s = {
            "n": len(cok),
            "norm_wer": met.summarize([c["norm_wer"] for c in cok]),
            "norm_diac_wer": met.summarize([c["norm_diac_wer"] for c in cok]),
            "norm_cer": met.summarize([c["norm_cer"] for c in cok]),
            "basic_wer": met.summarize([c["basic_wer"] for c in cok]),
            "wer_median": met.summarize([c["norm_wer"] for c in cok]).get("median"),
            "recorded_wer": met.summarize([c["norm_wer"] for c in recorded if c["ok"]]),
            "ok_rate": round(sum(1 for c in cs if c["ok"]) / len(cs), 4) if cs else None,
            "latency_s": met.summarize([c["latency_s"] for c in cs]),
            "latency_median": met.summarize([c["latency_s"] for c in cs]).get("median"),
            "error_types": {
                "ins": sum(c["norm_ins"] for c in cok),
                "del": sum(c["norm_del"] for c in cok),
                "sub": sum(c["norm_sub"] for c in cok),
                "hits": sum(c["norm_hits"] for c in cok),
                "n_ref": sum(c["norm_n_ref"] for c in cok),
            },
            "rtfx": _rtfx(cok),
            "nwer": _numeric_wer(cok),
            "accent_breakdown": _grouped([c for c in corpus], "accent"),
            "source_breakdown": _grouped([c for c in corpus], "source"),
            "language_breakdown": lbreak,
            "language_cer_breakdown": lcer,
            "language_diac_wer_breakdown": ldiac,
            "macro_wer": met.macro_average(lbreak),
            "macro_cer": met.macro_average(lcer),
            "macro_diac_wer": met.macro_average(ldiac),
            "money": mo.summarize_outcomes([c["money"] for c in cs if c.get("money")]),
            "money_scenario": mo.summarize_outcomes(
                [c["money"] for c in cs if c.get("money") and not is_synthetic(c)]),
            "money_synthetic": mo.summarize_outcomes(
                [c["money"] for c in syn if c.get("money")]),
            "money_recorded": mo.summarize_outcomes(
                [c["money"] for c in recorded if c.get("money")]),
            "synthetic_n": len(syn),
            "recorded_n": len(recorded),
            "codeswitch": _codeswitch_summary(codeswitch),
        }
        s["credit_est"] = round(
            sum(float(c["audio_sec"]) * CREDITS_PER_AUDIO_SEC for c in cok), 1)
        summary[prov] = s
    return summary


def _rtfx(cells: list[dict]) -> float | None:
    """Inverse real-time factor = audio seconds / wall seconds (>1 = faster
    than realtime). Industry convention (Open ASR Leaderboard): higher=better."""
    latency_ok = [c for c in cells if c.get("latency_s") and c["latency_s"] > 0]
    if not latency_ok:
        return None
    denom = sum(float(c["latency_s"]) for c in latency_ok)
    numer = sum(float(c["audio_sec"]) for c in latency_ok)
    return round(numer / denom, 2) if denom else None


def _numeric_wer(cells: list[dict]) -> dict | None:
    """NWER (numeric word error rate): WER over the subset of corpus clips
    whose reference contains at least one digit (prices/quantities/pins).
    AfriVox-v2 (2025) reports NWER as the deployment-critical signal:
    numbers are the failure mode that costs money. None if no clip qualifies."""
    num = [c for c in cells if c["ok"] and c["text_ref"] and any(ch.isdigit() for ch in c["text_ref"])]
    if not num:
        return None
    s = met.summarize([c["norm_wer"] for c in num])
    s["n"] = len(num)
    return s


TRANS_COLUMNS = [
    "provider", "id", "source", "root", "language", "accent",
    "audio_path", "ok", "latency_s", "audio_sec", "norm_wer", "norm_diac_wer",
    "norm_cer", "basic_wer", "ins", "del", "sub", "n_ref", "scenario_id",
    "text_ref", "text_hyp",
]


def _backfill_cell_metrics(cell: dict) -> dict:
    """Recompute scoring fields for cells produced under an older schema.

    Merging per-tag output preserves cells from previous runs whose dicts may
    predate a new metric (e.g. norm_diac_wer). Recompute from the raw stored
    reference + hypothesis so every row carries the full current schema."""
    if "norm_diac_wer" not in cell:
        cell.update(met.cell_metrics(cell.get("text_ref", ""),
                                     cell.get("text", ""),
                                     cell.get("language", "")))
    return cell


def write_transcripts(trans_dir: Path, cells: list[dict]) -> None:
    """Publish every hypothesis (raw + normalized) per provider as TSV evidence.

    This is the transparency artifact: WER/CER/error counts in the report are
    re-derivable from these rows alone (norm_wer_consistent is asserted per
    cell at scoring time). References for open corpora are public; the recorded
    brief scripts are committed alongside the source audio."""
    by_prov: dict[str, list[dict]] = {}
    for c in cells:
        by_prov.setdefault(c["provider"], []).append(c)
    for prov, cs in sorted(by_prov.items()):
        path = trans_dir / f"{prov}.tsv"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=TRANS_COLUMNS, delimiter="\t",
                               extrasaction="ignore")
            w.writeheader()
            for c in sorted(cs, key=lambda x: x["id"]):
                _backfill_cell_metrics(c)
                w.writerow({
                    "provider": prov, "id": c["id"], "source": c.get("source"),
                    "root": c.get("root"), "language": c.get("language"),
                    "accent": c.get("accent"), "audio_path": c["audio_path"],
                    "ok": c.get("ok"), "latency_s": c.get("latency_s"),
                    "audio_sec": c.get("audio_sec"), "norm_wer": c.get("norm_wer"),
                    "norm_diac_wer": c.get("norm_diac_wer"),
                    "norm_cer": c.get("norm_cer"), "basic_wer": c.get("basic_wer"),
                    "ins": c.get("norm_ins"), "del": c.get("norm_del"),
                    "sub": c.get("norm_sub"), "n_ref": c.get("norm_n_ref"),
                    "scenario_id": c.get("scenario_id") or "",
                    "text_ref": c["text_ref"], "text_hyp": c.get("text") or "",
                })
    (trans_dir / "README.md").write_text(
        "Per-cell transcript evidence for the Sautice STT benchmark. One TSV "
        "per provider; columns: raw reference and hypothesis, normalized WER/CER, "
        "error-type counts (ins/del/sub), latency. Every aggregate in report.md "
        "re-derives from these rows. Cache and per_cell.jsonl stay local; this "
        "evidence is committed for transparency.\n")
    print(f"[out] transcripts -> {trans_dir}")


def methodology() -> dict:
    """Reproducibility block for results.json (industry-standard metadata)."""
    import jiwer
    import platform
    import sys

    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True,
            check=True).stdout.strip()
    except Exception:
        commit = "git-describe-unavailable"
    try:
        jiwer_ver = __import__("importlib.metadata").metadata.version("jiwer")
    except Exception:
        jiwer_ver = "unknown"
    return {
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "git_commit": commit,
        "metrics_version": met.METRICS_VERSION,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "deps": {
            "jiwer": jiwer_ver,
            "whisper_normalizer": "locked-scheme (see eval/metrics.py)",
        },
        "audio_pipeline": "16k mono PCM via ffmpeg (see load_data / --add-recordings)",
        "scoring": {
            "wer": "WER = (S + D + I) / N via jiwer on symmetrically normalized "
                   "ref+hyp (N = reference length = S+D+H)",
            "cer": "jiwer.cer on same normalized pairs",
            "diac_preserving_wer": "norm_diac_wer: same pipeline with "
                                   "preserve_marks=True; tone gap = norm − diac-p",
            "macro": "unweighted mean of per-language means (WAXAL/SimbaBench)",
            "norm_scheme": "whisper-normalizer: EnglishTextNormalizer (en) / "
                           "BasicTextNormalizer(remove_diacritics) (other); frozen "
                           "in benchmarks/eval/metrics.py before scoring",
            "ci": "95% t-based CI over per-sample scores (normal approx n>30)",
            "error_types": "ins/del/sub/hits from jiwer.process_words on the "
                           "norm pair; stored per cell with a consistency assert",
        },
        "corpora": {
            "asr-nigerian-pidgin/nigerian-pidgin-1.0": "10 pidgin clips (train split)",
            "AlaminI/nigerian_common_voice_dataset": "20 clips en/ha/ig/yo (train split)",
            "McGill-NLP/NaijaS2ST": "30 clips ENx15 + EYx15 (dev split dev-00000)",
        },
        "transparency": {
            "per_cell_hypotheses": "outputs/<tag>/transcripts/<provider>.tsv "
                                   "(committed)",
            "per_cell_raw": "outputs/<tag>/per_cell.jsonl (local only, git-ignored)",
            "cost_ledger": "outputs/<tag>/cost.json (committed)",
        },
    }


def provider_snapshots() -> dict:
    """Exact model identifiers per configured provider (industry-standard pins)."""
    from .providers import PROVIDERS

    out: dict[str, str] = {}
    for name, cls in PROVIDERS.items():
        mod = __import__(f"benchmarks.providers.{name}", fromlist=["_DEFAULT_MODEL"])
        out[name] = getattr(mod, "_DEFAULT_MODEL", "api-default (see provider module)")
    return out


def _grouped(cells: list[dict], key: str, metric: str = "norm_wer") -> dict:
    out = {}
    for c in cells:
        if not c.get("ok"):
            continue
        g = c.get(key) or "?"
        out.setdefault(g, []).append(c.get(metric, c["norm_wer"]))
    return {g: met.summarize(v) for g, v in out.items()}


def _codeswitch_summary(cells: list[dict]) -> dict:
    """Track 3: WER/CER on code-switched recordings plus the invoice outcome.

    The human reference is also run through the invoice engine. That "ceiling"
    separates ASR errors from engine/catalogue limits: the conditional exact rate
    only counts clips where the reference itself yields the exact invoice.
    Failed provider calls stay in the denominators (scored as empty transcripts).
    """
    if not cells:
        return {"n": 0}
    ok = [c for c in cells if c["ok"]]
    roster = mo.load_roster()
    scenarios = {s["id"]: s for s in mo.load_scenarios()["scenarios"]}
    reference_exact: dict[str, bool] = {}
    for c in cells:
        if c["id"] not in reference_exact and c.get("scenario_id") in scenarios:
            outcome = mo.score_scenario(c["text_ref"], scenarios[c["scenario_id"]], roster)["outcome"]
            reference_exact[c["id"]] = outcome == "exact"
    eligible = [c for c in cells if reference_exact.get(c["id"])]
    return {
        "n": len(cells),
        "ok": len(ok),
        "audio_sec": round(sum(float(c["duration"]) for c in cells), 1),
        "speakers": len({c["id"].split("_")[1] for c in cells if c["id"].count("_") >= 2}),
        "norm_wer": met.summarize([c["norm_wer"] for c in ok]),
        "norm_cer": met.summarize([c["norm_cer"] for c in ok]),
        "basic_wer": met.summarize([c["basic_wer"] for c in ok]),
        "language_wer": _grouped(ok, "language"),
        "language_cer": _grouped(ok, "language", "norm_cer"),
        "money_all": mo.summarize_outcomes([c["money"] for c in cells if c.get("money")]),
        "reference_exact": sum(1 for v in reference_exact.values() if v),
        "reference_scored": len(reference_exact),
        "money_given_reference_exact": mo.summarize_outcomes(
            [c["money"] for c in eligible if c.get("money")]),
        "latency_s": met.summarize([c["latency_s"] for c in cells]),
    }


def _pct(x, d):
    return f"{x / d * 100:.1f}%" if d else "-"


def render_report(tag: str, summary: dict) -> str:
    lines = [f"# Sautice STT Benchmark — `{tag}`", ""]
    lines.append(f"Generated: {os.environ.get('BENCH_TODAY', '') or __import__('datetime').date.today().isoformat()}")
    lines.append("")
    lines.append("Two tracks, distinct validity claims:")
    lines.append("- **Track 1 — ASR quality (industry-standard metrics).** WER/CER via `jiwer` "
                 "with frozen whisper-normalizer preprocessing over open, human-transcribed "
                 "corpora (Nigerian Common Voice subset, NaijaS2ST, Nigerian pidgin), "
                 "stratified by accent/language. Comparable to OpenASR/MLPerf-style reporting.")
    lines.append("- **Track 2 — Sautice product probe (NOT a benchmark).** End-to-end "
                 "voice→invoice accuracy of the Sautice stack (ASR + Sautice heuristic parser). "
                 "Scores conflate both systems and are not comparable outside Sautice; "
                 "reported for downstream-provider decisions only.")
    lines.append("")
    lines.append("## Methodology & transparency (industry-standard)")
    lines.append("- **Scoring:** WER = (S + D + I) / N and CER via `jiwer`, computed on "
                 "**symmetrically normalized** reference + hypothesis (whisper-normalizer: "
                 "`EnglishTextNormalizer` for english, `BasicTextNormalizer(remove_diacritics)` "
                 "for the rest). Scheme is frozen in `benchmarks/eval/metrics.py`.")
    lines.append("- **Diacritics-preserving companion (`WER diac-p`):** same normalization but "
                 "keeps tone diacritics (`preserve_marks=True`), so tonal error is scored "
                 "instead of erased. `tone gap = norm − diac-p` (<0 means the frozen scheme "
                 "flattered the provider by dropping tone marks). 2026 African-ASR practice "
                 "(FER/TER, OpenWER); identical to `norm` for english by construction.")
    lines.append("- **Macro averages:** unweighted mean over per-language means (WAXAL/SimbaBench "
                 "convention) so each language counts once; the sample mean is pooled over clips.")
    lines.append("- **Auditability:** every raw hypothesis is published in "
                 f"`outputs/{tag}/transcripts/<provider>.tsv` (reference, raw hypothesis, "
                 "normalized WER/CER incl. diac-p, ins/del/sub counts, latency). Any aggregate "
                 "below re-derives from those rows; each cell asserts WER == (S+D+I)/N at "
                 "scoring time for both norm and diac-p.")
    lines.append("- **Provenance:** corpora pinned by Hugging Face repo + split (see "
                 "`benchmarks/README.md` → References). Audio pipeline: 16k mono PCM via ffmpeg.")
    lines.append("- **Reproducibility:** env pinned via `uv.lock`; `results.json` records "
                 "git commit, dependency versions, provider model snapshots and the CI method.")
    lines.append("")
    lines.append("## Track 1 — ASR quality (standard)")
    lines.append("| provider | n (corpus) | norm WER (95% CI) | median (IQR) | norm CER | "
                 "WER diac-p | tone gap | NWER (numbers) | macro WER | macro CER | RTFx | latency | "
                 "cost est. (cr) |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for prov, s in sorted(summary.items()):
        w = s["norm_wer"]
        wstr = f"{w['mean']*100:.1f}% (±{w['ci95']*100:.1f})" if (w["mean"] is not None and w["ci95"] is not None) else "-"
        med = f"{s['wer_median']*100:.1f}% ({s['norm_wer']['q25']*100:.1f}–{s['norm_wer']['q75']*100:.1f})" if s["wer_median"] is not None else "-"
        c = s["norm_cer"]
        cstr = f"{c['mean']*100:.1f}%" if c["mean"] is not None else "-"
        d = s["norm_diac_wer"]
        dstr = f"{d['mean']*100:.1f}%" if d["mean"] is not None else "-"
        tgap = (w["mean"] - d["mean"]) * 100 if (w["mean"] is not None and d["mean"] is not None) else None
        tgstr = f"{tgap:+.1f}" if tgap is not None else "-"
        nw = s.get("nwer")
        nwstr = f"{nw['mean']*100:.1f}% (n={nw['n']})" if nw and nw["mean"] is not None else "-"
        mw, mc = s["macro_wer"], s["macro_cer"]
        mwstr = f"{mw['mean']*100:.1f}%" if mw["mean"] is not None else "-"
        mcstr = f"{mc['mean']*100:.1f}%" if mc["mean"] is not None else "-"
        r = f"{s['rtfx']:.1f}x" if s["rtfx"] is not None else "-"
        l = s["latency_s"]
        lstr = f"{l['mean']:.1f}s" if l["mean"] is not None else "-"
        lines.append(f"| {prov} | {s['n']} | {wstr} | {med} | {cstr} | {dstr} | {tgstr} | "
                     f"{nwstr} | {mwstr} | {mcstr} | {r} | {lstr} | {s['credit_est']} |")
    lines.append("")
    lines.append("### Track 1 — error types (norm scoring, corpus; % of reference words)")
    lines.append("| provider | subs | dels | ins | (word match) | n words |")
    lines.append("|---|---|---|---|---|---|")
    for prov, s in sorted(summary.items()):
        e = s["error_types"]
        nref = e["n_ref"] or 1
        lines.append(f"| {prov} | {_pct(e['sub'], nref)} | {_pct(e['del'], nref)} | "
                     f"{_pct(e['ins'], nref)} | {_pct(e['hits'], nref)} | {e['n_ref']} |")
    lines.append("")
    lines.append("### Track 1 — accent / language / source breakdown (norm WER)")
    for prov, s in sorted(summary.items()):
        lines.append(f"**{prov}**")
        for key, label in (("accent_breakdown", "accent"), ("language_breakdown", "language"),
                           ("source_breakdown", "source")):
            row = " · ".join(f"{g} {v['mean']*100:.1f}% (n={v['n']})"
                             for g, v in sorted(s[key].items()) if v["mean"] is not None)
            lines.append(f"- {label}: {row}")
        lines.append("")

    lines.append("### Track 1 — per-language WER vs CER vs tone loss (macro at bottom)")
    lines.append("| provider | language | n | WER | WER diac-p | CER | gap (WER−CER) | tone gap (norm−diac) |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for prov, s in sorted(summary.items()):
        langset = set(s["language_breakdown"]) | set(s["language_cer_breakdown"]) | \
            set(s["language_diac_wer_breakdown"])
        for lang in sorted(langset):
            w = s["language_breakdown"].get(lang)
            c = s["language_cer_breakdown"].get(lang)
            dd = s["language_diac_wer_breakdown"].get(lang)
            if not w or not c or w["mean"] is None or c["mean"] is None:
                continue
            gap = (w["mean"] - c["mean"]) * 100
            dstr = f"{dd['mean']*100:.1f}%" if (dd and dd["mean"] is not None) else "-"
            tgap = (w["mean"] - dd["mean"]) * 100 if (dd and dd["mean"] is not None) else None
            tgstr = f"{tgap:+.1f}" if tgap is not None else "-"
            lines.append(f"| {prov} | {lang} | {w['n']} | {w['mean']*100:.1f}% | {dstr} | "
                         f"{c['mean']*100:.1f}% | {gap:+.1f} | {tgstr} |")
        mw, mc, md = s["macro_wer"], s["macro_cer"], s["macro_diac_wer"]
        mwstr = f"{mw['mean']*100:.1f}%" if mw["mean"] is not None else "-"
        mcstr = f"{mc['mean']*100:.1f}%" if mc["mean"] is not None else "-"
        mdstr = f"{md['mean']*100:.1f}%" if md["mean"] is not None else "-"
        lines.append(f"| {prov} | **macro (unwtd over {mw.get('n_groups','-')} langs)** | — | "
                     f"{mwstr} | {mdstr} | {mcstr} | — | — |")
    lines.append("")
    lines.append("Notes on Track 1 metrics: **CER** is the linguistically-valid signal for "
                 "tone/accent African languages (2026 ACL work shows WER misreads phonetic "
                 "loss as lexical error — Yoruba e.g. BERT WER 78.8% vs CER 30.5%). "
                 "**NWER** = WER over only clips whose reference contains a digit — the "
                 "deployment signal that matters for money amounts (AfriVox-v2). WER reads "
                 "high for these languages largely due to missing language-specific "
                 "normalization (OpenWER); read it as an upper bound.")
    lines.append("")

    lines.append("## Track 2 — Sautice product probe (ASR + Sautice parser; separate validity)")
    lines.append("| provider | n | exact | off≤10% | catastrophic>10% | blocked | exact rate |")
    lines.append("|---|---|---|---|---|---|---|")
    for label, bucket in (("recorded briefs", "money_recorded"),
                          ("synthetic TTS (deprecated)", "money_synthetic")):
        for prov, s in sorted(summary.items()):
            m = s.get(bucket) or {}
            if not m.get("n"):
                continue
            cells_txt = " | ".join(str(m.get(k, 0)) for k in
                                   ("exact", "off_small", "catastrophic", "blocked"))
            lines.append(f"| {prov} {label} | {m['n']} | {cells_txt} | {_pct(m.get('exact',0), m.get('n',0))} |")
    lines.append("")
    lines.append("### Supplementary — recorded briefs WER (paired to canonical scripts)")
    lines.append("| provider | n | norm WER |")
    lines.append("|---|---|---|")
    for prov, s in sorted(summary.items()):
        rw = s["recorded_wer"]
        if s["recorded_n"] and rw["mean"] is not None:
            lines.append(f"| {prov} | {s['recorded_n']} | {rw['mean']*100:.1f}% |")
    lines.append("")
    lines.append("Notes: Track 2 blocked rows are cases the parser could not resolve (ASR "
                 "hallucination or normalization gap in Sautice customer matching). "
                 "Recorded rows are live human recordings of the SautiBench money briefs; "
                 "synthetic rows are Intron-TTS clips retained as an auxiliary signal.")
    return "\n".join(lines) + "\n"


def synth_tts(args) -> None:
    sys.path.insert(0, str(BENCH))
    from .eval.sautibench_tts import resample_16k_manifest_rows, synthesize_scenarios

    print("[tts] synthesizing scenario briefs (live Intron TTS, slow, costs credits)...")
    rows = synthesize_scenarios(ids=args.tts_ids, force=args.tts_force, debug=args.tts_debug)
    resample_16k_manifest_rows(rows)
    _merge_tts_into_manifest(rows)
    print(f"[tts] done: {len(rows)} clips")


def _merge_tts_into_manifest(rows: list[dict]) -> None:
    """Append synthesized scenario clips to the pilot manifest as synthetic rows
    (canonical 16k mono path), so the runner scores their money outcome."""
    import numpy as np
    import soundfile as sf

    existing = {r["id"]: r for r in load_rows()}
    for r in rows:
        sid16k = r["audio_path_16k"]
        info = sf.info(sid16k)
        vid = f"tts_{r['scenario_id']}"
        existing[vid] = {
            "id": vid,
            "audio_path": sid16k,
            "duration": str(round(info.duration, 3)),
            "text_ref": r["text_ref"],
            "language": r["language"],
            "accent": r["accent"],
            "root": "sautibench",
            "source": "synthetic",
            "scenario_id": r["scenario_id"],
        }
    header = ["id", "audio_path", "duration", "text_ref", "language",
              "accent", "root", "source", "scenario_id"]
    rows_sorted = sorted(existing.values(),
                         key=lambda x: (x["source"] == "synthetic", x["id"]))
    with open(MANIFEST, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows_sorted)
    n_syn = sum(1 for r in existing.values() if r["source"] == "synthetic")
    print(f"[tts] merged manifest: {len(existing)} rows ({n_syn} synthetic)")


def add_recordings(directory: str, mapping_path: str | None = None) -> None:
    """Import your own recordings of the SautiBench money briefs.

    Each audio file is mapped to a scenario id via:
      - a filename like sXX.ext (scenario inferred), else
      - benchmarks/data/created/mapping.json keyed by filename stem.
    Clips are ffmpeg-converted to canonical 16k mono wav, appended to the
    manifest as source="recorded" human cells, and scored on money outcome.
    Unconfirmed mappings are skipped with a warning.
    """
    import soundfile as sf

    from .eval.sautibench_tts import _scenarios, _tts_prompt

    src_dir = Path(directory)
    if not src_dir.is_dir():
        print(f"[-] no such dir: {src_dir}")
        return

    mapping = None
    if mapping_path and Path(mapping_path).exists():
        mapping = json.loads(Path(mapping_path).read_text())

    prompts = {s["id"]: _tts_prompt(s) for s in _scenarios()}

    existing = load_rows()
    by_id = {r["id"]: r for r in existing}
    added, skipped = [], []
    dst_dir = DATA / "audio" / "16k"
    dst_dir.mkdir(parents=True, exist_ok=True)

    for f in sorted(src_dir.iterdir()):
        if not f.is_file() or f.suffix.lower() in {".json", ".md", ".txt"}:
            continue
        stem = f.stem
        sid = None
        if stem.startswith("s") and stem[1:].isdigit():
            sid = f"s{stem[1:]:0>2}"
        elif mapping:
            entry = mapping.get(stem) or {}
            if entry.get("confirmed"):
                sid = entry.get("scenario_id")
        if not sid or sid not in prompts:
            skipped.append((f.name, "unconfirmed mapping / unknown scenario"))
            continue

        vid = f"rec_{sid}"
        dst = dst_dir / f"recorded_{sid}.wav"
        if not dst.exists() or dst.stat().st_mtime < f.stat().st_mtime:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(f),
                 "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
                check=True)
        info = sf.info(dst)
        by_id[vid] = {
            "id": vid,
            "audio_path": str(dst),
            "duration": str(round(info.duration, 3)),
            "text_ref": prompts[sid],
            "language": "english",
            "accent": "recorded",
            "root": "sautibench",
            "source": "recorded",
            "scenario_id": sid,
        }
        added.append(vid)

    header = ["id", "audio_path", "duration", "text_ref", "language",
              "accent", "root", "source", "scenario_id"]
    with open(MANIFEST, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(sorted(by_id.values(), key=lambda x: x["id"]))
    n_rec = sum(1 for r in by_id.values() if r["source"] == "recorded")
    print(f"[rec] merged {len(added)} recorded rows (manifest={len(by_id)}, recorded={n_rec})")
    for name, why in skipped:
        print(f"  [rec] skip {name}: {why}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Sautice STT benchmark runner")
    ap.add_argument("--providers", nargs="*", default=None,
                    help="default: all configured (intron_sahara groq_whisper gemini elevenlabs)")
    ap.add_argument("--tag", default="pilot")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore local cache (still write results) — forces a cold API run")
    ap.add_argument("--max-cells", type=int, default=None)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--balance", type=float, default=1530.0, help="Intron credit balance")
    ap.add_argument("--cost-warn", type=float, default=450.0)
    ap.add_argument("--no-report", action="store_true")
    ap.add_argument("--synthesize-tts", action="store_true")
    ap.add_argument("--tts-ids", nargs="*", default=None)
    ap.add_argument("--tts-force", action="store_true")
    ap.add_argument("--tts-debug", action="store_true")
    ap.add_argument("--add-recordings", type=str, default=None,
                    help="import user-recorded money briefs from DIR (see data/created/)")
    ap.add_argument("--add-recordings-mapping", type=str, default=None)
    ap.add_argument("--codeswitch-template", type=str, default=None,
                    help="write/extend data/sautibench/references.csv from recorder folders in DIR")
    ap.add_argument("--add-codeswitch", type=str, default=None,
                    help="append consented code-switched recordings from DIR (Track 3)")
    args = ap.parse_args()

    if args.codeswitch_template:
        from .codeswitch import write_reference_template
        n = write_reference_template(Path(args.codeswitch_template))
        print(f"[cs] references template has {n} rows; fill reference_text by hand (never from ASR)")
        return 0
    if args.add_codeswitch:
        from .codeswitch import ingest
        added, skipped = ingest(Path(args.add_codeswitch))
        print(f"[cs] added {len(added)} code-switched rows")
        for name, why in skipped:
            print(f"  [cs] skip {name}: {why}")
        return 0
    if args.synthesize_tts:
        synth_tts(args)
        return 0
    if args.add_recordings:
        add_recordings(args.add_recordings, args.add_recordings_mapping)
        return 0

    cells, run_cost = run(args)
    if not cells:
        return 1
    write_outputs(args.tag, cells, load_rows(), balance=args.balance, run_cost=run_cost)
    try:
        from . import reference_audit
        reference_audit.audit(args.tag)
    except Exception as exc:  # audit is advisory; never fail the run
        print(f"[audit] skipped: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())