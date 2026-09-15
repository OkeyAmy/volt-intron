from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from typing import Optional


@dataclass
class Result:
    """One transcription cell. Never raises: errors are captured in `error`."""

    text: str = ""
    provider: str = ""
    audio: str = ""
    language: str = ""
    source: str = ""
    latency_s: float = 0.0
    audio_sec: float = 0.0
    ok: bool = False
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


class ASRProvider(ABC):
    """Interface every provider implements. `transcribe` never raises."""

    name: str = "base"

    def transcribe(self, audio_path: str, language: str,
                   source: str = "", timeout_s: int = 300) -> Result:
        start = time.monotonic()
        res = Result(provider=self.name, audio=audio_path,
                     language=language, source=source)
        try:
            text = self._transcribe(audio_path, language, timeout_s)
            res.text = (text or "").strip()
            res.ok = bool(res.text)
        except Exception as exc:  # noqa: BLE001 - capture, never leak
            res.error = f"{type(exc).__name__}: {exc}"
        res.latency_s = round(time.monotonic() - start, 3)
        res.audio_sec = round(_audio_seconds(audio_path), 3)
        return res

    def requires(self) -> dict[str, bool]:
        """env-var name -> configured? Used to skip providers cleanly."""
        return {}

    @abstractmethod
    def _transcribe(self, audio_path: str, language: str, timeout_s: int) -> str:
        ...


def _audio_seconds(audio_path: str) -> float:
    import soundfile as sf

    try:
        info = sf.info(audio_path)
        return info.frames / info.samplerate
    except Exception:
        return 0.0