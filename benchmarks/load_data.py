"""Phase 1 (pull) + Phase 2 (build) of the benchmark corpus.

Pull: whole-file, resumable downloads to a local cache (huggingface_hub
byte-resume) - never streaming, because the network is unreliable.
Build: fully offline scan of the pulled parquet, shortest-clip sampling per
group, 16k mono resample, cache purge, frozen pilot_manifest.csv.

The NaijaS2ST dev split is scanned shard-by-shard for EN*/EY*/EB* accents
(10+10+10 target) and stops early; datasets-server /filter is unreliable and
never used. If the byte cap hits before the accent target, we degrade
gracefully and record it in the manifest metadata.

Usage:  uv run python -m benchmarks.load_data [--rebuild] [--keep-corpora]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import hf_hub_download

from .providers.intron_sahara import _to_pcm16_16k_mono

REPO_NID_NAIJA = "McGill-NLP/NaijaS2ST"
REPO_PIDGIN = "asr-nigerian-pidgin/nigerian-pidgin-1.0"
REPO_ALAMIN = "AlaminI/nigerian_common_voice_dataset"

DATA = Path(__file__).resolve().parent / "data"
CORPORA = DATA / "corpora"
HUBCACHE = DATA / "hub_cache"
AUDIO16K = DATA / "audio" / "16k"
MANIFEST = DATA / "pilot_manifest.csv"
MANIFEST_JSON = DATA / "pilot_manifest_info.json"

PIDGIN_FILES = ["data/train-00000-of-00002-06caf65bef6a8834.parquet"]
ALAMIN_FILES = [
    "english/train-00000-of-00001.parquet",
    "hausa/train-00000-of-00001.parquet",
    "igbo/train-00000-of-00001.parquet",
    "yoruba/train-00000-of-00001.parquet",
]
NAIJA_DEV_FILES = [f"data/dev-{i:05d}-of-00012.parquet" for i in range(12)]

TARGETS = {
    "pidgin": {"group": ("pidgin",), "k": 10},
    "alamins": {"group": ("english", "hausa", "igbo", "yoruba"), "k": 5},
    # dev shards 0-1 hold only EN (Northern) + EY (Southern) Nigerian English.
    # British-Nigerian (EB) sits in a later dev block behind the igbo/yoruba/
    # pidgin blocks; excluded to keep the pull inside budget.
    "naija": {"accent_groups": ("EN", "EY"), "k": 15},
}
MIN_SEC, MAX_SEC = 3.0, 20.0
TEXT_COL_CANDIDATES = ("text", "transcription", "sentence", "normalized text")


# --- low-level audio extraction --------------------------------------------

def _audio_from_row(row: dict, repo_id: str) -> bytes:
    """Return 16k-safe raw audio bytes for a parquet row (duck-typed)."""
    # embedded bytes (datasets Audio feature -> struct or binary)
    a = row.get("audio")
    if isinstance(a, dict):
        for k in ("bytes", "array"):
            if k in a:
                v = a[k]
                if isinstance(v, (bytes, bytearray)):
                    return bytes(v)
                return np.asarray(v, dtype=np.int16).astype("<i2").tobytes()
        p = a.get("path")
        if p:
            return _fetch_path_bytes(repo_id, p)
        raise ValueError("audio struct with no bytes/path")
    if isinstance(a, (list, tuple)):
        return np.asarray(a, dtype=np.int16).astype("<i2").tobytes()
    p = row.get("path") or row.get("file") or row.get("audio_path")
    if isinstance(p, str) and p and _looks_like_repo_file(p):
        return _fetch_path_bytes(repo_id, p)
    raise ValueError(f"no usable audio in row (audio={a!r:.80}, path={p!r})")


def _looks_like_repo_file(p: str) -> bool:
    return not p.startswith("http") and not p.startswith("file:")


def _fetch_path_bytes(repo_id: str, p: str) -> bytes:
    local = hf_hub_download(
        repo_id, p, repo_type="dataset", cache_dir=str(HUBCACHE)
    )
    return Path(local).read_bytes()


def _audio_seconds(data_or_path_bytes: bytes, sr: int) -> float:
    """Duration of raw PCM int16 bytes at sr, or of a wav file path."""
    return len(data_or_path_bytes) / 2 / sr


def _audio_info(bytes_or_container: bytes) -> tuple[int, int] | None:
    """(samplerate, frames) for a soundfile-readable container (wav/mp3/...)."""
    import io

    import soundfile as sf

    try:
        i = sf.info(io.BytesIO(bytes_or_container))
        return int(i.samplerate), int(i.frames)
    except Exception:
        return None


def _decode_to_int16(bytes_or_container: bytes) -> tuple[np.ndarray, int]:
    """Decode an audio container (wav/mp3/...) to int16 samples + its samplerate.
    Falls back to treating the bytes as raw int16 PCM."""
    import io

    import soundfile as sf

    try:
        data, sr = sf.read(io.BytesIO(bytes_or_container), dtype="int16",
                           always_2d=False)
        return np.asarray(data, dtype="<i2"), int(sr)
    except Exception:
        return np.frombuffer(bytes_or_container, dtype="<i2"), 16000


# --- schema adapters -------------------------------------------------------

def _text_from_row(row: dict) -> str:
    for c in TEXT_COL_CANDIDATES:
        if c in row and isinstance(row[c], str):
            return row[c].strip()
    return ""


def iter_pidgin(path: Path):
    df = pd.read_parquet(path)
    for _, row in df.iterrows():
        r = dict(row)
        yield {
            "bytes": _audio_from_row(r, REPO_PIDGIN),
            "samplerate": int(r.get("sampling_rate") or r.get("original_sample_rate") or 48000 or 16000),
            "text": _text_from_row(r),
            "language": "pidgin",
            "accent": "pidgin",
            "source": "nigerian-pidgin",
        }


def iter_alamins(path: Path, language: str):
    df = pd.read_parquet(path)
    for _, row in df.iterrows():
        r = dict(row)
        yield {
            "bytes": _audio_from_row(r, REPO_ALAMIN),
            "samplerate": int(r.get("original_sample_rate") or 16000),
            "text": _text_from_row(r),
            "language": language,
            "accent": "nigerian-cv",
            "source": "alamin-cv",
        }


def iter_naija_dev(path: Path):
    df = pd.read_parquet(path)
    for _, row in df.iterrows():
        r = dict(row)
        uid = str(r.get("user_id", ""))
        accent = uid[:2] if len(uid) >= 2 else "??"
        lang = str(r.get("language", "")).lower()
        sr = int(r.get("original_sample_rate") or r.get("sampling_rate") or 48000)
        yield {
            "bytes": _audio_from_row(r, REPO_NID_NAIJA),
            "samplerate": sr,
            "text": _text_from_row(r),
            "language": lang if lang in ("english", "pidgin", "yoruba", "igbo", "hausa") else "english",
            "accent": accent,
            "source": "naija-s2st",
            "user_id": uid,
            "duration": float(r.get("duration") or 0.0),
        }


# --- pull ------------------------------------------------------------------

def pull_file(repo_id: str, filename: str) -> Path:
    local = hf_hub_download(repo_id, filename, repo_type="dataset",
                            cache_dir=str(HUBCACHE))
    return Path(local)


def pull_pidgin(**kw) -> list[Path]:
    return [pull_file(REPO_PIDGIN, f) for f in PIDGIN_FILES]


def pull_alamins(**kw) -> dict[str, Path]:
    """Return {language: local parquet path} for the four CV language dirs."""
    out = {}
    for f in ALAMIN_FILES:
        lang = f.split("/")[0]
        out[lang] = pull_file(REPO_ALAMIN, f)
    return out


def pull_naija_dev(cap_mb: int, target: int = 30, **kw) -> list[Path]:
    """Scan-and-stop over dev shards until each of the requested accent buckets
    (default EN/EY) has >= `target` rows banked, or the byte cap is hit. Shards
    without any requested accent rows are dropped. Buckets that never appear
    (e.g. EB) are recorded as a warning, not a hard failure - the caller stocks
    per-bucket clips only for the accents actually present."""
    buckets = kw.pop("buckets", ("EN", "EY"))
    paths = []
    downloaded_by_shard: list[int] = []
    cap_bytes = cap_mb * 1024 * 1024
    banked = {b: 0 for b in buckets}
    for shard in NAIJA_DEV_FILES:
        if min(banked.values()) >= target:
            print(f"  [naija] accent buckets satisfied: {banked}; stopping")
            break
        if sum(downloaded_by_shard) >= cap_bytes:
            print(f"  [naija] cap {cap_mb} MB reached at {banked}; degrading")
            break
        local = pull_file(REPO_NID_NAIJA, shard)
        size = local.stat().st_size
        downloaded_by_shard.append(size)
        counts = {b: 0 for b in buckets}
        for row in iter_naija_dev(local):
            if row["accent"] in counts:
                counts[row["accent"]] += 1
        hit = sum(counts.values())
        if hit > 0:
            paths.append(local)
            for k in banked:
                banked[k] += min(counts[k], target)  # cap per-shard counting
            print(f"  [naija] {shard}: {counts} "
                  f"(downloaded {sum(downloaded_by_shard)/1e6:.0f} MB, banked {banked})")
        else:
            print(f"  [naija] {shard}: no requested accents, dropping {local}")
            local.unlink(missing_ok=True)
    if min(banked.values()) < target:
        print(f"  [naija] WARNING: some accent buckets short: {banked}")
    return paths


_PULLERS = {"pidgin": pull_pidgin, "alamins": pull_alamins, "naija": pull_naija_dev}


# --- sampling --------------------------------------------------------------

def sample_group(groups: dict, targets: dict, rng: random.Random,
                 prefix: str = "") -> list[dict]:
    """Pick the K shortest clips per group key (row duration inside 3-20s)."""
    picked = []
    for key, rows in groups.items():
        k = targets.get("k")
        if k is None:  # per-accent target needs distinct bucket keys
            continue
        rows = [r for r in rows if MIN_SEC <= _row_dur(r) <= MAX_SEC]
        rows.sort(key=lambda r: (_row_dur(r), rng.random()))
        for r in rows[:k]:
            r["pick_group"] = key
            picked.append(r)
    return picked


def _row_dur(r: dict) -> float:
    if r.get("duration"):
        return r["duration"]
    info = _audio_info(r["bytes"])
    if info:
        sr, frames = info
        r["samplerate"] = sr
        return frames / sr
    return _audio_seconds(r["bytes"], r.get("samplerate", 16000))


def buckets_for(rows: list[dict], keyer, targets: dict) -> list[dict]:
    groups: dict = {}
    for r in rows:
        groups.setdefault(keyer(r), []).append(r)
    by_key = {}
    out = []
    for key, rs in groups.items():
        rs = [r for r in rs if MIN_SEC <= _row_dur(r) <= MAX_SEC]
        rs.sort(key=lambda r: (_row_dur(r), random.Random(hash(r["text"] or "") % 2**32).random()))
        taken = rs[: targets.get("k", 1)]
        by_key[key] = len(taken)
        for r in taken:
            r["pick_group"] = key
            out.append(r)
    return out


# --- build -----------------------------------------------------------------

def _write_wav(r: dict, out: Path) -> None:
    import soundfile as sf

    data, sr = _decode_to_int16(r["bytes"])
    if sr != 16000:
        data = _resample_int16(data, sr, 16000)
    sf.write(str(out), data, 16000, subtype="PCM_16")


def _resample_int16(data: np.ndarray, sr: int, target: int = 16000) -> np.ndarray:
    mono = np.asarray(data, dtype=np.float32) / 32767.0
    n = int(round(len(mono) * target / sr))
    x = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)
    return (np.clip(x, -1, 1) * 32767).astype("<i2")


def build_manifest(pull_paths: dict, rng: random.Random) -> list[dict]:
    AUDIO16K.mkdir(parents=True, exist_ok=True)
    rows = []

    pid = pull_paths.get("pidgin", [])
    pd_rows = []
    for p in pid:
        pd_rows.extend(iter_pidgin(p))
    picked = buckets_for(pd_rows, lambda r: ("pidgin", r["accent"]), TARGETS["pidgin"])
    for r in picked:
        rows.append(_emit(r, "pidgin", rng))

    al = pull_paths.get("alamins", {})
    for lang, path in al.items():
        lang_rows = list(iter_alamins(path, lang))
        for r in buckets_for(lang_rows, lambda r: ("alamin", r["language"]), TARGETS["alamins"]):
            rows.append(_emit(r, f"alamin_{lang}", rng))

    accents = TARGETS["naija"]["accent_groups"]
    naija = pull_paths.get("naija", [])
    nj_rows = []
    for p in naija:
        nj_rows.extend(iter_naija_dev(p))
    for acc in accents:
        acc_rows = [r for r in nj_rows if r["accent"] == acc]
        picked_acc = buckets_for(acc_rows, lambda r: ("naija", acc), {"k": TARGETS["naija"]["k"]})
        for r in picked_acc:
            rows.append(_emit(r, f"naija_{acc}", rng))

    return rows


def _emit(r: dict, tag: str, rng: random.Random) -> dict:
    clip_id = f"{tag}_{rng.randint(1000, 9999)}"
    out = AUDIO16K / f"{clip_id}.wav"
    _write_wav(r, out)
    return {
        "id": clip_id,
        "audio_path": str(out.resolve()),
        "duration": round(_row_dur(r), 3),
        "text_ref": r.get("text", ""),
        "language": r.get("language", "english"),
        "source": r.get("source", tag),
        "root": r.get("source", tag),
        "accent": r.get("accent", ""),
        "scenario_id": r.get("scenario_id", ""),
    }


# --- main ------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Pull + build the Sautice pilot corpus")
    ap.add_argument("--rebuild", action="store_true", help="ignore existing manifest")
    ap.add_argument("--keep-corpora", action="store_true", help="do not purge pulled parquet")
    ap.add_argument("--naija-cap-mb", type=int, default=1650)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--only", choices=["pidgin", "alamins", "naija"], default=None)
    ap.add_argument("--info", action="store_true",
                    help="print corpus provenance (pilot_manifest_info.json) and exit")
    args = ap.parse_args()

    if args.info:
        import json as _json
        if MANIFEST_JSON.exists():
            print(_json.dumps(_json.loads(MANIFEST_JSON.read_text()), indent=2))
        else:
            print("[-] no pilot_manifest_info.json yet — run a build first")
            return 1
        return 0

    if MANIFEST.exists() and not args.rebuild:
        print(f"[-] manifest already exists at {MANIFEST} (use --rebuild).")
        print(f"    rows: {sum(1 for _ in open(MANIFEST)) - 1}")
        return 0

    # synthetic TTS clips are generated by run.py --synthesize-tts (live, paid);
    # they are pulled here only if already materialized.
    tts_rows = _load_tts_rows()

    only = [args.only] if args.only else list(_PULLERS)
    pull_paths: dict = {}
    for name in only:
        print(f"[pull] {name}")
        extra = {}
        if name == "naija":
            extra["target"] = TARGETS["naija"]["k"]
            extra["buckets"] = TARGETS["naija"]["accent_groups"]
        pull_paths[name] = _PULLERS[name](cap_mb=args.naija_cap_mb, seed=args.seed, **extra)

    rng = random.Random(args.seed)
    rows = build_manifest(pull_paths, rng) + tts_rows

    with open(MANIFEST, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    info = {
        "pulled": {k: {kk: str(vv) for kk, vv in v.items()} if isinstance(v, dict)
                   else [str(p) for p in v]
                   for k, v in pull_paths.items()},
        "manifest": str(MANIFEST),
        "rows": len(rows),
        "naija_cap_mb": args.naija_cap_mb,
        "seed": args.seed,
    }
    MANIFEST_JSON.write_text(json.dumps(info, indent=2))
    print(f"[build] wrote {MANIFEST}: {len(rows)} rows")

    if not args.keep_corpora:
        shutil.rmtree(HUBCACHE, ignore_errors=True)
        shutil.rmtree(CORPORA, ignore_errors=True)
        print("[purge] hub cache + corpora removed (use --keep-corpora to retain)")
    return 0


def _load_tts_rows() -> list[dict]:
    tts_manifest = DATA / "sautibench" / "tts_manifest.csv"
    if not tts_manifest.exists():
        return []
    with open(tts_manifest) as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        src16 = r.get("audio_path_16k") or r.get("audio_path")
        if not src16 or not Path(src16).exists():
            continue
        out.append({
            "id": r["id"],
            "audio_path": src16,
            "duration": round(_wav_sec(src16), 3),
            "text_ref": r.get("text_ref", ""),
            "language": r.get("language", "english"),
            "source": "synthetic",
            "root": "sautibench",
            "accent": "synthetic",
            "scenario_id": r.get("scenario_id", ""),
        })
    return out


def _wav_sec(path: str) -> float:
    import soundfile as sf

    try:
        i = sf.info(path)
        return i.frames / i.samplerate
    except Exception:
        return 0.0


if __name__ == "__main__":
    sys.exit(main())