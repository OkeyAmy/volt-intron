"""Intron Sahara via the streaming STT API.

Ported unchanged from Intron-Multimodal-Benchmarking/scripts/models/sahara_api.py.
    wss://infer.voice.intron.io/stt/v1/stream?sample_rate=16000&bit_rate=16\
        &num_channels=1&use_language_asr_input=<code>
with an Authorization: Bearer handshake and PCM16 16k mono chunks sent as base64.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time

import numpy as np
import soundfile as sf
import websockets

from .base import ASRProvider

_WS = "wss://infer.voice.intron.io/stt/v1/stream"

LANG_CODES = {
    "english": "en",
    "afrikaans": "af",
    "swahili": "sw",
    "yoruba": "yo",
    "hausa": "ha",
    "igbo": "ig",
    "pidgin": "pcm",
}
_DEFAULT_CODE = "en"

# burn documented in docs/research.md
CREDITS_PER_AUDIO_SEC = 0.44


class IntronSahara(ASRProvider):
    name = "intron_sahara"

    def requires(self) -> dict[str, bool]:
        return {"INTRON_API_KEY": bool(os.environ.get("INTRON_API_KEY"))}

    def _transcribe(self, audio_path: str, language: str, timeout_s: int) -> str:
        key = os.environ.get("INTRON_API_KEY") or os.environ.get("API_KEY")
        if not key:
            raise RuntimeError("set INTRON_API_KEY (or API_KEY) in .env to run Sahara API")
        code = LANG_CODES.get(language.lower(), _DEFAULT_CODE)
        pcm = _to_pcm16_16k_mono(audio_path)
        # The streaming endpoint throttles rapid connections (closes with 1002 /
        # RESOURCE_* handshakes once the session slots are busy), so retry with a
        # long-ish backoff. Bounded so a hard outage still surfaces quickly.
        _RETRIES, _BACKOFF = 6, (3, 6, 10, 15, 25, 40)
        _retryable = (websockets.ConnectionClosed, RuntimeError, OSError, TimeoutError)
        last = None
        for attempt in range(_RETRIES):
            try:
                return asyncio.run(_stream(pcm, code, key, timeout_s))
            except _retryable as e:
                last = e
                if attempt < _RETRIES - 1:
                    time.sleep(_BACKOFF[attempt])
        raise last


def _to_pcm16_16k_mono(path: str) -> bytes:
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        n = int(round(len(mono) * 16000 / sr))
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)
    return (np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()


async def _stream(pcm: bytes, lang_code: str, key: str, timeout_s: int) -> str:
    url = (
        f"{_WS}?sample_rate=16000&bit_rate=16&num_channels=1"
        f"&use_language_asr_input={lang_code}"
    )
    result = None
    async with websockets.connect(
        url, additional_headers={"Authorization": f"Bearer {key}"}
    ) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout_s))
        if hello.get("message_type") != "SESSION_CREATED":
            raise RuntimeError(f"unexpected Intron handshake: {hello}")

        async def send():
            CH = 8000
            for i in range(0, len(pcm), CH):
                await ws.send(
                    json.dumps(
                        {
                            "message_type": "INPUT_AUDIO_CHUNK",
                            "audio_base_64": base64.b64encode(pcm[i : i + CH]).decode(),
                            "ack_id": i // CH + 1,
                        }
                    )
                )
                await asyncio.sleep(0.05)
            await ws.send(json.dumps({"message_type": "COMMIT"}))

        task = asyncio.create_task(send())
        try:
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout_s))
                mt = m.get("message_type")
                if mt == "COMMITTED_TRANSCRIPT":
                    result = m.get("transcript_text")
                    break
                if mt in (
                    "ERROR",
                    "INPUT_ERROR",
                    "AUTHENTICATION_ERROR",
                    "QUOTA_EXCEEDED",
                ):
                    raise RuntimeError(f"{mt}: {m}")
        finally:
            task.cancel()
    return result or ""