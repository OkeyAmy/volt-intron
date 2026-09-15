from .base import ASRProvider, Result
from .elevenlabs import ElevenLabs
from .gemini import Gemini
from .groq_whisper import GroqWhisper
from .intron_sahara import IntronSahara

PROVIDERS: dict[str, type[ASRProvider]] = {
    "intron_sahara": IntronSahara,
    "groq_whisper": GroqWhisper,
    "gemini": Gemini,
    "elevenlabs": ElevenLabs,
}


def get_provider(name: str) -> ASRProvider:
    if name not in PROVIDERS:
        raise KeyError(f"unknown provider '{name}'; have {sorted(PROVIDERS)}")
    return PROVIDERS[name]()


def resolve_providers(names: list[str] | None) -> dict[str, ASRProvider]:
    """Return name -> provider for the requested names (all if None), skipping
    any whose environment requirements are unsatisfied."""
    wanted = names if names else sorted(PROVIDERS)
    out: dict[str, ASRProvider] = {}
    for n in wanted:
        p = get_provider(n)
        missing = [k for k, ok in p.requires().items() if not ok]
        if missing:
            print(f"  [skip] {n}: missing env keys {missing}")
            continue
        out[n] = p
    return out


__all__ = ["ASRProvider", "Result", "PROVIDERS", "get_provider", "resolve_providers"]