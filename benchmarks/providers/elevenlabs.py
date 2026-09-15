"""ElevenLabs Scribe v1 speech-to-text via HTTP multipart upload."""
from __future__ import annotations

import os

import requests

from .base import ASRProvider

_URL = "https://api.elevenlabs.io/v1/speech-to-text"
_DEFAULT_MODEL = "scribe_v1"

LANG_CODES = {
    "english": "en",
    "afrikaans": "af",
    "swahili": "sw",
    "yoruba": "yo",
    "hausa": "ha",
    "igbo": "ig",
}
# Scribe has no pidgin code; omit language_code and let it auto-detect.
_PIDGIN = "pidgin"


class ElevenLabs(ASRProvider):
    name = "elevenlabs"

    def requires(self) -> dict[str, bool]:
        return {"ELEVENLABS_API_KEY": bool(os.environ.get("ELEVENLABS_API_KEY"))}

    def _transcribe(self, audio_path: str, language: str, timeout_s: int) -> str:
        key = os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            raise RuntimeError("set ELEVENLABS_API_KEY in .env to run ElevenLabs")
        headers = {"xi-api-key": key}
        data = {"model_id": _DEFAULT_MODEL}
        lang = language.lower()
        if lang != _PIDGIN:
            data["language_code"] = LANG_CODES.get(lang, lang)
        with open(audio_path, "rb") as f:
            files = {"file": (f.name, f, "audio/wav")}
            resp = requests.post(_URL, headers=headers, data=data,
                                 files=files, timeout=timeout_s)
        resp.raise_for_status()
        return (resp.json().get("text") or "").strip()