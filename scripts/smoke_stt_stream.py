"""Day-0 smoke test: Intron streaming STT. Verifies protocol, latency, language codes."""
import asyncio, base64, json, os, pathlib, sys, time, wave
import numpy as np, soundfile as sf, httpx, websockets

def _seed_env_from_dotenv():
    """Load the repo-root .env so the script runs without manual `set -a; . ./.env`."""
    dotenv = pathlib.Path(__file__).resolve().parent.parent / ".env"
    if not dotenv.exists():
        return
    for line in dotenv.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

_seed_env_from_dotenv()

# INTRON_API_KEY is the documented name; API_KEY is accepted so an existing
# .env from early exploration keeps working.
KEY = os.environ.get("INTRON_API_KEY") or os.environ.get("API_KEY")
if not KEY:
    sys.exit("No API key: set INTRON_API_KEY in the repo-root .env file and retry.")
WS = "wss://infer.voice.intron.io/stt/v1/stream"

def to_pcm16_16k_mono(path: str) -> bytes:
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:  # linear resample; fine for a smoke test
        n = int(round(len(mono) * 16000 / sr))
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)
    return (np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()

async def run(pcm: bytes, lang: str):
    url = f"{WS}?sample_rate=16000&bit_rate=16&num_channels=1&use_language_asr_input={lang}"
    t0 = time.monotonic(); first_partial = None; partials = 0; final = None
    async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {KEY}"}) as ws:
        hello = json.loads(await ws.recv())
        print(f"  SESSION_CREATED  credits={hello.get('credit_balance')}  configs={hello.get('configs')}")

        async def send():
            CH = 8000  # bytes, within 1KB..32KB
            for i in range(0, len(pcm), CH):
                await ws.send(json.dumps({"message_type": "INPUT_AUDIO_CHUNK",
                                          "audio_base_64": base64.b64encode(pcm[i:i+CH]).decode(),
                                          "ack_id": i // CH + 1}))
                await asyncio.sleep(0.05)
            await ws.send(json.dumps({"message_type": "COMMIT"}))

        task = asyncio.create_task(send())
        try:
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                mt = m.get("message_type")
                if mt == "PARTIAL_TRANSCRIPT":
                    partials += 1
                    if first_partial is None:
                        first_partial = time.monotonic() - t0
                elif mt == "COMMITTED_TRANSCRIPT":
                    final = m.get("transcript_text"); break
                elif mt in ("ERROR", "INPUT_ERROR", "AUTHENTICATION_ERROR", "QUOTA_EXCEEDED"):
                    print(f"  !! {mt}: {m}"); break
        except (asyncio.TimeoutError, websockets.ConnectionClosed) as e:
            print(f"  !! closed: {type(e).__name__} {e}")
        task.cancel()
    print(f"  lang={lang}  partials={partials}  first_partial={first_partial}  total={time.monotonic()-t0:.2f}s")
    print(f"  FINAL: {final!r}")

async def main():
    src = sys.argv[1]
    pcm = to_pcm16_16k_mono(src)
    print(f"audio: {len(pcm)/2/16000:.2f}s  {len(pcm)} bytes PCM16")
    for lang in sys.argv[2:]:
        print(f"\n--- use_language_asr_input={lang} ---")
        await run(pcm, lang)

asyncio.run(main())
