"""Groq-hosted Whisper via the OpenAI-compatible transcription endpoint."""
from __future__ import annotations

import os

from .base import ASRProvider

_DEFAULT_MODEL = "whisper-large-v3-turbo"

LANG_CODES = {
    "english": "en",
    "afrikaans": "af",
    "swahili": "sw",
    "yoruba": "yo",
    "hausa": "ha",
    "igbo": "ig",
    "pidgin": "en",  # Whisper has no pidgin code
}


class GroqWhisper(ASRProvider):
    name = "groq_whisper"

    def requires(self) -> dict[str, bool]:
        return {"GROQ_API_KEY": bool(os.environ.get("GROQ_API_KEY"))}

    def _transcribe(self, audio_path: str, language: str, timeout_s: int) -> str:
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            raise RuntimeError("set GROQ_API_KEY in .env to run Groq Whisper")
        from openai import OpenAI

        client = OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1")
        lang = LANG_CODES.get(language.lower(), "en")
        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                model=_DEFAULT_MODEL,
                file=f,
                language=lang,
                response_format="text",
                timeout=timeout_s,
            )
        text = resp if isinstance(resp, str) else getattr(resp, "text", "")
        return (text or "").strip()