"""Track 3 ingestion must only admit consented, human-referenced, in-spec clips,
and must keep them out of the Track 1 corpus numbers."""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmarks import codeswitch as cs  # noqa: E402
from benchmarks import run as runner  # noqa: E402

CONSENT = {k: True for k in cs.CONSENT_KEYS}


def _wav(path: Path, seconds: float = 1.0, sr: int = 16000, channels: int = 1) -> None:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    tone = (0.1 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    sf.write(str(path), tone if channels == 1 else np.stack([tone] * channels, axis=1), sr, subtype="PCM_16")


def _speaker(root: Path, speaker: str, clips: list[dict]) -> Path:
    d = root / speaker
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"speaker": {"speaker_id": speaker}, "clips": clips}))
    return d


def _clip(speaker: str, sid: str, **over) -> dict:
    base = {"audio_file": f"{speaker}_{sid}.wav", "scenario_id": sid, "speaker_id": speaker,
            "language_pair": "pcm-en", "country": "NG", "accent_region": "NG-south-west",
            "domain": "commerce/invoicing", "device": "Android phone — built-in mic",
            "environment": "quiet_room", "consent": dict(CONSENT)}
    base.update(over)
    return base


def _refs(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cs.REFERENCE_HEADER)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in cs.REFERENCE_HEADER})


def test_ingest_admits_only_eligible_clips(tmp_path: Path):
    root = tmp_path / "rec"
    d = _speaker(root, "SPK1", [
        _clip("SPK1", "s01"),                                            # eligible
        _clip("SPK1", "s02"),                                            # no reference
        _clip("SPK1", "s03", consent={**CONSENT, "public_hf": False}),   # consent incomplete
        _clip("SPK1", "s04"),                                            # 44.1 kHz
        _clip("SPK1", "s05", language_pair="xx-en"),                     # unknown pair
    ])
    _wav(d / "SPK1_s01.wav")
    _wav(d / "SPK1_s02.wav")
    _wav(d / "SPK1_s03.wav")
    _wav(d / "SPK1_s04.wav", sr=44100)
    _wav(d / "SPK1_s05.wav")
    refs = tmp_path / "references.csv"
    _refs(refs, [{"audio_file": f"SPK1_{s}.wav", "reference_text": "Abeg five bags Dangote cement for Adebayo Stores"}
                 for s in ("s01", "s03", "s04", "s05")])
    manifest = tmp_path / "manifest.csv"
    with open(manifest, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cs.MANIFEST_HEADER)
        w.writeheader()
        w.writerow({"id": "alamin_english_1", "audio_path": "/x.wav", "duration": "3", "text_ref": "hi",
                    "language": "english", "accent": "nigerian-cv", "root": "alamin-cv",
                    "source": "alamin-cv", "scenario_id": ""})

    added, skipped = cs.ingest(root, manifest, refs, tmp_path / "meta.json",
                               scenario_ids={"s01", "s02", "s03", "s04", "s05"})

    assert added == ["cs_SPK1_s01"]
    reasons = dict(skipped)
    assert reasons["SPK1_s02.wav"] == "no human reference transcript yet"
    assert reasons["SPK1_s03.wav"] == "consent incomplete"
    assert reasons["SPK1_s04.wav"].startswith("expected 16 kHz mono WAV")
    assert reasons["SPK1_s05.wav"].startswith("unknown language pair")

    rows = {r["id"]: r for r in csv.DictReader(open(manifest))}
    assert set(rows) == {"alamin_english_1", "cs_SPK1_s01"}           # corpus row untouched
    assert rows["cs_SPK1_s01"]["language"] == "pidgin"
    assert rows["cs_SPK1_s01"]["source"] == "codeswitch"
    meta = json.loads((tmp_path / "meta.json").read_text())
    assert meta["cs_SPK1_s01"]["accent_region"] == "NG-south-west"
    assert meta["cs_SPK1_s01"]["domain"] == "commerce/invoicing"


def test_ingest_is_idempotent_and_keeps_speakers_apart(tmp_path: Path):
    root = tmp_path / "rec"
    for spk in ("SPKA", "SPKB"):
        d = _speaker(root, spk, [_clip(spk, "s01")])
        _wav(d / f"{spk}_s01.wav")
    refs = tmp_path / "references.csv"
    _refs(refs, [{"audio_file": f"{s}_s01.wav", "reference_text": "five bags cement"} for s in ("SPKA", "SPKB")])
    manifest = tmp_path / "manifest.csv"
    for _ in range(2):
        added, _ = cs.ingest(root, manifest, refs, tmp_path / "meta.json", scenario_ids={"s01"})
    assert sorted(added) == ["cs_SPKA_s01", "cs_SPKB_s01"]
    assert len(list(csv.DictReader(open(manifest)))) == 2


def test_reference_template_keeps_typed_text(tmp_path: Path):
    root = tmp_path / "rec"
    d = _speaker(root, "SPK1", [_clip("SPK1", "s01"), _clip("SPK1", "s02")])
    _wav(d / "SPK1_s01.wav")
    refs = tmp_path / "references.csv"
    _refs(refs, [{"audio_file": "SPK1_s01.wav", "reference_text": "typed by a human", "annotator": "A"}])
    assert cs.write_reference_template(root, refs) == 2
    got = cs.load_references(refs)
    assert got["SPK1_s01.wav"]["reference_text"] == "typed by a human"
    assert got["SPK1_s02.wav"]["reference_text"] == ""


def _cell(id_: str, source: str, wer: float, scenario_id: str = "", text_ref: str = "x") -> dict:
    return {"id": id_, "provider": "p", "ok": True, "source": source, "language": "pidgin",
            "accent": "a", "norm_wer": wer, "norm_cer": wer / 2, "basic_wer": wer,
            "latency_s": 1.0, "audio_sec": 2.0, "duration": "2.0", "text_ref": text_ref,
            "scenario_id": scenario_id, "money": {"outcome": "blocked", "ready": False}}


def test_summary_keeps_codeswitch_out_of_track1():
    cells = [
        _cell("alamin_1", "alamin-cv", 0.10),
        _cell("cs_SPK1_s01", "codeswitch", 0.50, scenario_id="s01",
              text_ref="Adebayo Stores bought 5 bags of Dangote Cement at 12,500 naira"),
    ]
    s = runner.summarize(cells)["p"]
    assert s["n"] == 1 and s["norm_wer"]["mean"] == 0.10
    assert s["codeswitch"]["n"] == 1
    assert s["codeswitch"]["norm_wer"]["mean"] == 0.50
    assert s["codeswitch"]["reference_scored"] == 1
