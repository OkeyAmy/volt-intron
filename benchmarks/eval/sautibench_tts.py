"""Synthesize the 30 SautiBench scenario briefs with Intron TTS.

Contract (docs/research.md): POST /tts/v1/generate with
voice_language / voice_accent / voice_gender; audio is returned on an S3 path.
voice_accent is a language-name taxonomy (yoruba/hausa/igbo/swahili/afrikaans
work for `en`; `naija`/`nigerian` do NOT - verified live 2026-09-15). The first
live call prints the raw response so the shape can be confirmed once against
fresh docs, then `normalize_response()` is adjusted. TTS is slow (~5 s + 0.6x
audio) and costs credits; call via `run.py --synthesize-tts`.

These clips are Intron-TTS output: OUT-OF-DISTRIBUTION for ASR and labelled
`source=synthetic` in the manifest. They exercise the invoice-money metric, not
accent quality.
"""
from __future__ import annotations

import base64
import csv
import json
from pathlib import Path

import requests

from ..providers.intron_sahara import _to_pcm16_16k_mono  # reuse resampler

_TTS_URL = "https://infer.voice.intron.io/tts/v1/generate"
_DATA = Path(__file__).resolve().parents[1] / "data" / "sautibench"

ENGLISH_ONLY_BRIEFS = True  # every brief is already English

_TERMS_SPOKEN = {
    "net_14": "fourteen days",
    "net_7": "seven days",
    "net_30": "thirty days",
    "net_60": "sixty days",
    "end_of_month": "end of month",
    None: "",
}

_PLURAL = {
    "bag": "bags", "length": "lengths", "bucket": "buckets", "tin": "tins",
    "sheet": "sheets", "trip": "trips", "roll": "rolls", "piece": "pieces",
}
_SINGULAR = {v: k for k, v in _PLURAL.items()}


def _spoken_name(description: str) -> str:
    """Drop size specifiers real speakers don't say ("Dangote Cement 50kg" ->
    "Dangote Cement"). The money heuristic mis-reads embedded digits like 50kg /
    20L / 12mm as quantities when TTS syllables them out."""
    import re

    return re.sub(
        r"\s*\d+(?:\.\d+)?(?:/\d+)?\s*(?:kg|l|g|ml|cl|mm|cm|inch|inches|"
        r"litre|liter|ft|ton|tonne)s?\b",
        "", description.strip(), flags=re.I,
    ).strip() or ("item" if not description else description)


def _tts_prompt(scenario: dict) -> str:
    """Canonical spoken invoice order the frozen Sautice heuristic engine parses.

    The raw `brief` says "to <customer> at list price", which the numbered
    heuristic cannot price (the account must speak naira digits). The prompt
    spells each expected line as "<qty> <unit-plural> of <product> at <price in
    naira digits>", joined by " and ", with the customer as the LAST token
    ("for <Customer>"), which is how extract.py anchors customer + terms. No
    terms clause: read_term_days only accepts digit "days", and terms are not
    money-scored. This is the exact text ASR must recover for a kobo-exact
    invoice.
    """
    from sautice.core.money import Money

    exp = scenario.get("expected", {})
    cust = (scenario.get("customer") or {}).get("name")
    parts = []
    for item in exp.get("items", []):
        qty = item.get("quantity", 1)
        unit = item.get("unit") or "unit"
        if qty == 1:
            unit = _SINGULAR.get(unit, unit)
        else:
            unit = _PLURAL.get(unit, unit + "s")
        name = _spoken_name(item.get("description") or "item")
        price = Money.from_kobo(item.get("unit_price_kobo", 0)).spoken()
        parts.append(f"{qty} {unit} of {name} at {price}")
    phrase = ", and ".join(parts) if len(parts) > 1 else parts[0]
    if cust:
        phrase += f" for {cust}"
    return phrase


def _scenarios() -> list[dict]:
    return json.loads((_DATA / "scenarios.json").read_text())["scenarios"]


def _voice_params() -> dict:
    # voice_accent is a *language name*, not a region tag: for language `en` the
    # endpoint accepts e.g. yoruba/hausa/igbo/swahili/afrikaans (verified live
    # 2026-09-15). `yoruba` -> a Southern-Nigerian-English (EY-flavoured) voice,
    # which matches the market briefs better than a flat US/British voice.
    return {"voice_language": "en", "voice_accent": "yoruba", "voice_gender": "female"}


def generate_tts(text: str, voice: dict | None = None,
                 debug: bool = False) -> dict:
    """Call the TTS endpoint and return {format, data/path, raw}. Adjusts to
    whatever envelope the live service returns."""
    import os
    import time

    key = os.environ.get("INTRON_API_KEY") or os.environ.get("API_KEY")
    if not key:
        raise RuntimeError("set INTRON_API_KEY to synthesize TTS clips")
    voice = dict(voice or _voice_params())
    # Like the STT stream, the TTS service resets rapid connections from one
    # client (ConnectionResetError / connection aborted), so retry with backoff.
    _RETRIES, _BACKOFF = 4, (2, 4, 8)
    last = None
    for attempt in range(_RETRIES):
        try:
            resp = requests.post(
                _TTS_URL,
                headers={"Authorization": f"Bearer {key}"},
                json={"text": text, **voice},
                timeout=300,
            )
            if debug:
                print(f"  [tts] status={resp.status_code} type={resp.headers.get('content-type')}"
                      f" len={len(resp.content)}")
                print("  [tts] body-preview:", resp.content[:300])
            resp.raise_for_status()
            ct = (resp.headers.get("content-type") or "").lower()
            if "json" in ct:
                return {"format": "json", "data": resp.json()}
            return {"format": "raw", "data": resp.content}
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            last = e
            if attempt < _RETRIES - 1:
                time.sleep(_BACKOFF[attempt])
    raise last


def synthesize_scenarios(ids: list[str] | None = None, force: bool = False,
                         debug: bool = False) -> list[dict]:
    """Build data/sautibench/tts/*.wav for the scenario briefs and freeze
    data/sautibench/tts_manifest.csv. Returns the manifest rows."""
    tts_dir = _DATA / "tts"
    tts_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in _scenarios():
        sid = s["id"]
        if ids and sid not in ids:
            continue
        out = tts_dir / f"{sid}.wav"
        if out.exists() and not force:
            rows.append(_manifest_row(s, out, "cached"))
            continue
        text = _tts_prompt(s)
        print(f"  [tts] {sid}: {text[:80]}...")
        got = generate_tts(text, debug=debug)
        wav = _extract_wav(got, s)
        if wav is None:
            raise RuntimeError(f"could not extract WAV from TTS response for {sid}: "
                               f"{got['data'] if got['format'] == 'json' else 'raw-bytes'}")
        out.write_bytes(wav)
        rows.append(_manifest_row(s, out, "generated"))
    _write_manifest(rows)
    return rows


def _extract_wav(got: dict, scenario: dict) -> bytes | None:
    if got["format"] == "raw":
        data = got["data"]
        if isinstance(data, bytes) and data[:4] == b"RIFF":
            return data
        return None
    data = got["data"]
    # The live service wraps the audio envelope as {"data": {audio_path, ...},
    # "message": ..., "status": ...}; descend one level when present.
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    if isinstance(data, dict):
        for k in ("audio", "audio_bytes", "wav"):
            if k in data and isinstance(data[k], str):
                try:
                    return base64.b64decode(data[k])
                except Exception:
                    continue
        path = data.get("audio_path") or data.get("audio_url") or data.get("url")
        if isinstance(path, str) and path.startswith("http"):
            return _fetch(path)
    return None


def _fetch(url: str, tries: int = 4, backoff: tuple = (2, 4, 8)) -> bytes:
    import time

    last = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=300)
            r.raise_for_status()
            return r.content
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            last = e
            if i < tries - 1:
                time.sleep(backoff[i])
    raise last


def _manifest_row(scenario: dict, wav: Path, status: str) -> dict:
    return {
        "id": f"tts_{scenario['id']}",
        "source_dir": "sautibench_tts",
        "root": "sautibench",
        "language": "english",
        "accent": "synthetic",
        "text_ref": _tts_prompt(scenario),
        "audio_path": str(wav.resolve()),
        "scenario_id": scenario["id"],
        "status": status,
    }


def _write_manifest(rows: list[dict]) -> None:
    path = _DATA / "tts_manifest.csv"
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"  [tts] wrote {path} ({len(rows)} rows)")


def resample_16k_manifest_rows(rows: list[dict]) -> None:
    """Convert cached tts wavs to canonical 16 kHz mono next to the manifest."""
    import soundfile as sf
    import numpy as np

    for row in rows:
        src = Path(row["audio_path"])
        dst = src.with_name(src.stem + "-16k.wav")
        pcm = _to_pcm16_16k_mono(str(src))
        data = np.frombuffer(pcm, dtype="<i2")
        sf.write(str(dst), data, 16000, subtype="PCM_16")
        row["audio_path_16k"] = str(dst.resolve())