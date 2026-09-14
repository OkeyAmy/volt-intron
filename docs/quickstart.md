# Quickstart

From a clean clone to a passing test suite in about two minutes. **No API keys are required** for
the tests — the financial core is deliberately offline so it can be verified by anyone.

## 1. Prerequisites

- [`uv`](https://docs.astral.sh/uv/) — handles Python itself, so nothing else is needed.
- Python **3.12**, pinned in `.python-version`. `uv` installs it for you.

> Why pinned: this machine's system Python is 3.14, which does not yet have wheels for parts of
> the stack. Pinning 3.12 avoids a build-from-source detour that has nothing to do with the project.

```bash
git clone https://github.com/OkeyAmy/volt-intron.git
cd volt-intron
uv sync
```

## 2. Run the tests

```bash
uv run pytest
```

Expected: **83 passed** — 32 for the money engine (including immutability and
sign-preserving `spoken()` regressions), 51 for the naira number grammar.

These run with no network and no credentials. If they pass, the parts of the system that decide
what a customer owes are working.

## 3. See the number grammar make a decision

The interesting behaviour is not that it parses numbers. It is that it refuses to guess:

```bash
uv run python -c "
from sautice.nlp.naira import read_amount
for s in ['twelve-five', '12.5k', 'two fifty', 'twenty five', 'twenty five thousand naira']:
    r = read_amount(s)
    print(f'{s:28} {r.note if r.is_ambiguous else r.value.format()}')
"
```

```
twelve-five                  ₦12,500
12.5k                        ₦12,500
two fifty                    could mean ₦250, ₦2,500, ₦250,000
twenty five                  could mean ₦25 or ₦25,000
twenty five thousand naira   ₦25,000
```

The two ambiguous rows are the product working correctly. At published code-switched error rates a
plausible reading is not a correct one, so those become a question to the user rather than a number
on an invoice.

## 4. Configure credentials (only needed for the voice layer)

```bash
cp .env.example .env
```

| Variable | Needed for | Required? |
|---|---|---|
| `INTRON_API_KEY` | Intron STT and TTS | For any voice feature |
| `GROQ_API_KEY` | The agent's extraction layer | For the agent (in progress) |
| `GROQ_MODEL` | Defaults to `openai/gpt-oss-120b` | No |
| `GEMINI_API_KEY`, `OPENAI_API_KEY` | Comparison models in the benchmark | Benchmark only |

Get an Intron key at <https://voice.intron.io/v2/developers>, and a Groq key at
<https://console.groq.com/keys>.

`.env` is gitignored. Never commit it.

## 5. Verify your Intron key end to end

```bash
set -a; . ./.env; set +a
uv run python scripts/smoke_stt_stream.py fixtures/smoke_pidgin.wav pcm en
```

This opens a real streaming WebSocket, sends PCM16 audio, and prints the partial and final
transcripts plus your remaining credit balance. It transcribes the same clip twice under two
different language codes, which is how the finding in [`research.md`](research.md) was discovered.

> Costs roughly 2 credits per run (~0.44 credits per second of audio).

## 6. Regenerate the build artefacts

Both generators are deterministic — running them leaves the working tree unchanged.

```bash
uv run python scripts/build_scenarios.py   # benchmark scenarios + computed ground-truth totals
uv run python scripts/build_recorder.py    # the standalone speaker recorder page
```

`build_recorder.py` injects `design/tokens.css` and the logo into the recorder, so the design
system has exactly one source of truth. **Never hand-edit** `scripts/recorder/sautice-recorder.html`
or `docs/index.html`; edit the template or the tokens and rebuild.

## 7. The speaker recorder

Published at <https://harystyleseze.github.io/sautice-recorder/>. It needs HTTPS, because browsers
only grant microphone access in a secure context — opening the file locally will not work.

To preview the layout without a microphone, open `docs/index.html` in a browser; the consent gate
and card rendering work, only recording is unavailable.

## What is not runnable yet

Stated plainly so nothing here is mistaken for working software:

| Component | Status |
|---|---|
| Money engine, naira number grammar | **Runs today**, 78 tests |
| Speaker recorder, benchmark scenario set | **Runs today** |
| Intron STT streaming | **Verified live** via `web/scripts/smoke-intron.mts` (real round trip) |
| Intron TTS | Not verified |
| Invoice engine, state machine | Not built |
| Roster resolver | Not built |
| Agent layer (Groq) | Not built |
| Benchmark harness | Not built |
| Web UI | Not built |

## Troubleshooting

| Symptom | Cause |
|---|---|
| `KeyError: 'API_KEY'` | `.env` not loaded. Run `set -a; . ./.env; set +a` first. |
| Smoke test returns HTTP 403 | Key rejected. The message is `permission denied,access-key error`. |
| Smoke test returns HTTP 500 | Auth **succeeded**; the resource is missing. Undocumented but expected. |
| `QUOTA_EXCEEDED` on the socket | Intron credits exhausted. |
| Microphone blocked in the recorder | Not an HTTPS origin. Use the published URL. |
