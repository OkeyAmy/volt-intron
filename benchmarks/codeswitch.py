"""Track 3: code-switched speech from consented SautiBench recordings.

The open corpora in Track 1 are monolingual or accented English; they cannot show
how a model handles a trader switching between Pidgin/Yoruba/Igbo/Hausa and English
mid-sentence. This track ingests clips made with the consent recorder
(scripts/recorder), each paired with a HUMAN verbatim reference transcript.

Input layout (one folder per speaker, as unzipped from the recorder):
    <root>/<speaker_id>/manifest.json   {"speaker": {...}, "clips": [...]}
    <root>/<speaker_id>/<speaker_id>_<scenario>.wav   16 kHz mono PCM16

References: benchmarks/data/sautibench/references.csv
    audio_file, scenario_id, language_pair, reference_text, annotator,
    check_text, check_annotator
reference_text is typed by a person who speaks the language, verbatim, and is never
pre-filled from any ASR output (that would bias WER toward the model used).
check_text is an optional second annotator's transcript, used only to report
inter-annotator agreement.

Rows are appended to the pilot manifest with source="codeswitch" and scored by the
normal runner; per-clip recorder metadata (country, accent region, domain, device,
environment) is kept in data/codeswitch_meta.json.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import soundfile as sf

BENCH = Path(__file__).resolve().parent
DATA = BENCH / "data"
MANIFEST = DATA / "pilot_manifest.csv"
REFERENCES = DATA / "sautibench" / "references.csv"
META = DATA / "codeswitch_meta.json"
SCENARIOS = DATA / "sautibench" / "scenarios.json"

SOURCE = "codeswitch"
MAX_SEC = 60.0  # the app's recording cap; inside every provider's limit
PAIR_TO_LANGUAGE = {
    "pcm-en": "pidgin",
    "yo-en": "yoruba",
    "ig-en": "igbo",
    "ha-en": "hausa",
    "en": "english",
}
CONSENT_KEYS = ("age18", "research_use", "public_hf", "no_real_pii", "withdrawable")
MANIFEST_HEADER = ["id", "audio_path", "duration", "text_ref", "language",
                   "accent", "root", "source", "scenario_id"]
REFERENCE_HEADER = ["audio_file", "scenario_id", "language_pair", "reference_text",
                    "annotator", "check_text", "check_annotator"]


def iter_clips(root: Path):
    """Yield (speaker_dir, clip) for every clip in every speaker manifest."""
    for d in sorted(p for p in Path(root).iterdir() if p.is_dir()):
        mf = d / "manifest.json"
        if not mf.exists():
            continue
        for clip in json.loads(mf.read_text()).get("clips", []):
            yield d, clip


def load_references(path: Path = REFERENCES) -> dict[str, dict]:
    if not Path(path).exists():
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {r["audio_file"]: r for r in csv.DictReader(f)}


def write_reference_template(root: Path, path: Path = REFERENCES) -> int:
    """Create/extend references.csv with one row per clip, keeping any text already
    typed. New rows have an empty reference_text for a human to fill in."""
    existing = load_references(path)
    rows = []
    for _d, clip in iter_clips(root):
        prev = existing.get(clip["audio_file"], {})
        rows.append({
            "audio_file": clip["audio_file"],
            "scenario_id": clip.get("scenario_id", ""),
            "language_pair": clip.get("language_pair", ""),
            **{k: prev.get(k, "") for k in ("reference_text", "annotator", "check_text", "check_annotator")},
        })
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=REFERENCE_HEADER)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def _scenario_ids(path: Path = SCENARIOS) -> set[str]:
    return {s["id"] for s in json.loads(Path(path).read_text())["scenarios"]}


def ingest(root: Path, manifest_path: Path = MANIFEST, references_path: Path = REFERENCES,
           meta_path: Path = META, scenario_ids: set[str] | None = None) -> tuple[list[str], list[tuple[str, str]]]:
    """Append eligible clips to the manifest as source="codeswitch" rows.

    Idempotent: previous codeswitch rows are replaced; other rows are untouched.
    A clip is skipped (with the reason reported, never silently) when consent is
    incomplete, the audio is missing, not 16 kHz mono, longer than MAX_SEC, the
    scenario or language pair is unknown, or no human reference exists yet.
    """
    scenario_ids = scenario_ids if scenario_ids is not None else _scenario_ids()
    refs = load_references(references_path)

    rows: list[dict] = []
    if Path(manifest_path).exists():
        with open(manifest_path, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if r.get("source") != SOURCE]

    added: list[str] = []
    skipped: list[tuple[str, str]] = []
    meta: dict[str, dict] = {}

    for d, clip in iter_clips(root):
        name = clip.get("audio_file", "?")
        consent = clip.get("consent") or {}
        if not all(consent.get(k) is True for k in CONSENT_KEYS):
            skipped.append((name, "consent incomplete"))
            continue
        wav = d / name
        if not wav.exists():
            skipped.append((name, "audio file missing"))
            continue
        sid = clip.get("scenario_id")
        if sid not in scenario_ids:
            skipped.append((name, f"unknown scenario {sid!r}"))
            continue
        language = PAIR_TO_LANGUAGE.get(clip.get("language_pair", ""))
        if not language:
            skipped.append((name, f"unknown language pair {clip.get('language_pair')!r}"))
            continue
        info = sf.info(str(wav))
        if info.samplerate != 16000 or info.channels != 1:
            skipped.append((name, f"expected 16 kHz mono WAV, got {info.samplerate} Hz x{info.channels}"))
            continue
        if info.duration > MAX_SEC:
            skipped.append((name, f"longer than {MAX_SEC:.0f}s ({info.duration:.1f}s)"))
            continue
        ref = (refs.get(name) or {}).get("reference_text", "").strip()
        if not ref:
            skipped.append((name, "no human reference transcript yet"))
            continue

        speaker = clip.get("speaker_id") or d.name
        rid = f"cs_{speaker}_{sid}"
        rows.append({
            "id": rid,
            "audio_path": str(wav.resolve()),
            "duration": str(round(info.duration, 3)),
            "text_ref": ref,
            "language": language,
            "accent": clip.get("accent_region") or "unspecified",
            "root": "sautibench",
            "source": SOURCE,
            "scenario_id": sid,
        })
        meta[rid] = {
            "audio_file": name,
            "speaker_id": speaker,
            "language_pair": clip.get("language_pair"),
            "country": clip.get("country"),
            "accent_region": clip.get("accent_region"),
            "domain": clip.get("domain") or "commerce/invoicing",
            "device": clip.get("device"),
            "environment": clip.get("environment"),
            "recorded_date": clip.get("recorded_date"),
            "duration_s": round(info.duration, 3),
            "annotator": (refs.get(name) or {}).get("annotator", ""),
        }
        added.append(rid)

    with open(manifest_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=MANIFEST_HEADER, extrasaction="ignore")
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["id"]))
    Path(meta_path).write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return added, skipped


def annotator_agreement(references_path: Path = REFERENCES) -> dict:
    """WER between the primary and second annotator where both exist (norm scheme)."""
    from .eval import metrics as met

    pairs = []
    for r in load_references(references_path).values():
        a, b = (r.get("reference_text") or "").strip(), (r.get("check_text") or "").strip()
        if a and b:
            language = PAIR_TO_LANGUAGE.get(r.get("language_pair", ""), "english")
            pairs.append(met.cell_metrics(a, b, language)["norm_wer"])
    return met.summarize(pairs)
