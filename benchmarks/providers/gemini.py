"""Google Gemini transcription via the generateContent REST API.

Rate-limit handling: multiple keys (GEMINI_API_KEY, GEMINI_API_KEY_2,
GENAI_API_KEY, GOOGLE_API_KEY) are tried in order. On a 429 / 503 / quota
exhaustion it rotates to the next key and retries with backoff, so a burst
spread across keys does not stall the benchmark.
"""
from __future__ import annotations

import base64
import json
import os
import time

import requests

from .base import ASRProvider

_REST = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_DEFAULT_MODEL = "gemini-3.8-flash"  # GA flagship (as of 2026-09); 3.1-pro-preview is the Pro tier
_KEY_ENVVARS = ("GEMINI_API_KEY", "GEMINI_API_KEY_2", "GENAI_API_KEY", "GOOGLE_API_KEY")
_THROTTLE_STATUSES = {429, 500, 503, 504}
_QUOTA_ERRORS = {"RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "UNAVAILABLE", "429"}


class Gemini(ASRProvider):
    name = "gemini"

    def requires(self) -> dict[str, bool]:
        return {"GEMINI_API_KEY_ANY": any(os.environ.get(k) for k in _KEY_ENVVARS)}

    def _transcribe(self, audio_path: str, language: str, timeout_s: int) -> str:
        keys = [os.environ[k] for k in _KEY_ENVVARS if os.environ.get(k)]
        if not keys:
            raise RuntimeError("set GEMINI_API_KEY in .env to run Gemini")
        with open(audio_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        prompt = (
            f"Transcribe this audio (spoken {language or 'English'}). "
            "Only output the transcription. No timestamps, no speaker labels."
        )
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"inline_data": {"mime_type": "audio/wav", "data": b64}},
                        {"text": prompt},
                    ],
                }
            ]
        }
        url = _REST.format(model=_DEFAULT_MODEL)

        for attempt, key in enumerate(_rotator(keys, len(keys) * 4)):
            backoff = min(2 ** (attempt // len(keys)), 30)
            try:
                resp = requests.post(url, params={"key": key}, json=payload,
                                     timeout=timeout_s)
            except requests.RequestException:
                if attempt == len(keys) * 4 - 1:
                    raise
                time.sleep(backoff + attempt // len(keys))
                continue
            if resp.status_code in _THROTTLE_STATUSES or _quota_exhausted(resp):
                if attempt == len(keys) * 4 - 1:
                    resp.raise_for_status()
                time.sleep(backoff + attempt // len(keys))
                continue
            resp.raise_for_status()
            data = resp.json()
            try:
                return data["candidates"][0]["content"]["parts"][0]["text"].strip()
            except (KeyError, IndexError):
                return ""


def _rotator(keys: list[str], limit: int):
    for i in range(limit):
        yield keys[i % len(keys)]


def _quota_exhausted(resp: requests.Response) -> bool:
    if resp.status_code != 400:
        return False
    try:
        status = (resp.json().get("error") or {}).get("status")
    except (ValueError, AttributeError, json.JSONDecodeError):
        return False
    return status in _QUOTA_ERRORS