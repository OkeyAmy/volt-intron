<div align="center">
<img src="design/logo-ink.svg#gh-light-mode-only" alt="Sautice" height="34">
<img src="design/logo-light.svg#gh-dark-mode-only" alt="Sautice" height="34">

**Voice-to-invoice for Nigerian SMEs — designed for speech recognition that gets one word in three wrong.**
Sautice combines the idea of voice (Sauti) in Swahili with invoice, reflecting the product's core workflow: speak a sale naturally, then turn it into a checked invoice.

Entry for the [Sahara CodeSwitch Africa Challenge 2026](https://www.intron.io/compete/) ·
category *Fintech, Telco & Customer Experience*

[Quickstart](docs/quickstart.md) · [Research log](docs/research.md) · [Recording protocol](docs/recording-protocol.md)
</div>

---

## Getting started

Two parts, one repo: the **financial core** (Python — offline, testable by anyone with no
credentials) and the **voice web app** (TypeScript — needs an Intron key for live speech).
For full detail, start at [`docs/quickstart.md`](docs/quickstart.md).

### Requirements

- [`uv`](https://docs.astral.sh/uv/) for Python — it installs Python 3.12 itself (pinned in
  `.python-version`; your system Python may be newer).
- [`pnpm`](https://pnpm.io/) and **Node.js ≥ 20.9** for the web app.

### 1. Financial core — no keys required

```bash
uv sync
uv run pytest          # 78 passed — money engine + naira number grammar, fully offline
```

Run the number-grammar demo that shows it **refusing to guess** (see `docs/quickstart.md §3` for the
full snippet and output):

```bash
uv run python -c "
from sautice.nlp.naira import read_amount
for s in ['two fifty', 'twelve-five', 'twenty five thousand naira']:
    print(s, '->', read_amount(s).format() if not read_amount(s).is_ambiguous else 'ambiguous - asks the user')
"
```

### 2. Voice web app — requires `INTRON_API_KEY`

```bash
cp .env.example .env   # then paste your Intron key in
cd web
pnpm install
pnpm dev               # http://localhost:3000
```

`pnpm dev` runs [`web/server.mts`](web/server.mts): a custom server hosting Next.js **and** the
WebSocket voice gateway on one port. The gateway lives at `/api/voice/stream`, and if it cannot see
a key it says so in an error message rather than failing silently. The server loads the repo-root
`.env` automatically (`tsx --env-file`), so no manual `export` is needed; in dev it auto-allows
`http://localhost:3000` in its origin allowlist (production uses `APP_URL`).

Other web commands:

| Command | What it does |
|---|---|
| `pnpm smoke:intron <file.wav> <lang...>` | Real Intron streaming round trip from TypeScript |
| `pnpm test` · `pnpm typecheck` · `pnpm lint` | Vitest (24), `tsc --noEmit`, ESLint |
| `pnpm build` + `pnpm start` | Production build behind the same custom server |

The Python equivalent of the smoke test is
`uv run python scripts/smoke_stt_stream.py <file.wav> pcm en` — it transcribes one clip under two
language codes and reports your remaining credit balance. Both smoke scripts read the repo-root
`.env` automatically (the TS one via `--env-file`, the Python one with a tiny loader), and both fail
with a clear *"set INTRON_API_KEY"* message instead of a crash if the key is missing.

### 3. Credentials

| Variable | Needed for |
|---|---|
| `INTRON_API_KEY` | All live speech (STT + TTS) — the only key the web app needs today |
| `GROQ_API_KEY`, `GROQ_MODEL` | The agent extraction layer — **not yet wired in** |
| `GEMINI_API_KEY`, `OPENAI_API_KEY` | Comparison models for the benchmark only |

Intron keys: <https://voice.intron.io/v2/developers> · Groq keys: <https://console.groq.com/keys>.
`.env` is gitignored — never commit it. `DEMO_MODE=true` in the example is a placeholder; nothing
reads it yet.

---

## The problem

A Nigerian trader selling cement does not speak the way invoicing software expects. They say
*"Abeg invoice Adebayo Stores, five bags, twelve-five each"* — switching between English and
Yoruba, Igbo, Hausa or Pidgin inside a single sentence. Typing that into a form is slower than
writing it in a carbon-copy book, so most never digitise it at all.

Voice should solve this. The obstacle is that code-switched African speech recognition is not
accurate enough to trust with money.

## Why this is hard, in numbers

Intron reports an average **34.3% word error rate** for Sahara v2.5 across 12 code-switched African
languages, against 53.8% for Gemini 3.6 — which, as
[TechCabal](https://techcabal.com/2026/08/26/intron-voice-ai/) summarises it, means *"about one word
wrong in three."* The [AfriSwitch benchmark](https://arxiv.org/abs/2608.26434) (61.36 hours of
in-the-wild code-switched speech, 16 languages) finds the best of five systems averages
**35.93% WER**, with no system below 24% on any language.

So the question worth answering is not *"can we transcribe African code-switched speech?"* It is:

> **What has to be true for a small business owner to trust a ~35%-WER transcript with their money?**

On our first live call to the Intron API, the same audio was transcribed two ways depending only
on the language code:

| `use_language_asr_input` | Transcript | Money |
|---|---|---|
| `pcm` | "Your total na **645** naira" | **₦645** |
| `en` | "Your total na **64,500** naira" | ₦64,500 |

A 100× error on an invoice total — and the *wrong* one reads as the more fluent sentence. Word
error rate cannot see that distinction; an invoice can.

> This clip was Intron TTS output, so it is a **protocol smoke test, not evidence**. It is recorded
> here because it shaped the design, not because it is a result. Real measurements will come from
> human recordings. See [`docs/research.md`](docs/research.md).

## Who it is for

Nigerian SMEs and micro-traders who sell business-to-business and already keep records by voice or
on paper. Nigeria has 39.6 million MSMEs, accounting for 87.9% of national employment
([SMEDAN–NBS National MSME Survey 2021](https://www.nigerianstat.gov.ng/elibrary/read/966)). The
design target is a mid-range Android phone on mobile data in a noisy environment, operated by
someone with no accounting software experience.

## How it works

Speak naturally. Intron Sahara transcribes the code-switched speech and the words appear in an
editable box, so a misheard word can be fixed before anything else happens. The engine then
resolves who and what you meant against your own customer and product list, computes the money
deterministically, shows you the draft, asks about anything it is unsure of, and issues the
invoice only after you confirm.

> **This flow runs today** in the web app (see [Status](#status)). Nothing in this README is written
> as working software unless that table says it is.

The invoice is the proof. The product is **voice → verified business action**.

## What makes it agentic

The transcript is not the output. It drives a multi-turn task: extract a transaction, detect what
is missing or ambiguous, ask a clarifying question in the user's own register, recompute, request
explicit confirmation, then issue a numbered invoice with an audit trail. The downstream artefact
is a real financial document, not text.

## Code-switching

Yoruba–English (`yo`), Igbo–English (`ig`), Hausa–English (`ha`) and Pidgin–English (`pcm`), via
Intron's code-switched language codes. Our evaluation set is built from *facts of a sale* rather
than scripts, so speakers switch where they naturally would instead of where a writer put the
switch point.

## Architecture

```
Browser AudioWorklet (16 kHz PCM16)
  ├─ stream ──> Node voice gateway (web/server.mts, key server-side) ──Bearer──> Sahara streaming STT
  │                └─ recoverable stream failure ──> bounded 60 s buffer ──> Sahara sync file STT
  └─ upload (serverless) ──> /api/voice/transcribe ──> Sahara sync file STT
                                     │  transcript — editable by the trader
                                     ▼
          deterministic extractor (Pidgin-aware) ──> tenant-scoped resolver (abstains on ambiguity)
                                     ▼
          naira number grammar (ambiguity sets) ──> money engine — integer kobo, no floats, half-up
                                     ▼
          draft + clarification questions ──> trader answers ──> version-bound, idempotent confirm
                                     ▼
          issued invoice (Postgres / SQLite) · printable page · share link
```

### Three design decisions, and what each one cost

Written as **constraint → decision → tradeoff**, so it is clear what was forced by a platform and
what was actually chosen.

**1. No language model in the money path.**
*Constraint:* at published code-switched error rates, a transcript can be fluent and still wrong
about an amount, and a generative model can "correct" it into a plausible wrong number.
*Decision:* extraction is a deterministic, tested rule set (Python engine with a TypeScript port
kept in parity), and money is an integer count of kobo that rejects floats outright, because float
arithmetic silently loses fractions of a kobo.
*Tradeoff:* less flexible phrasing than an LLM — unusual wording becomes a clarification question
rather than an improvisation. Common Pidgin shapes ("abeg", "wan buy", "make dem pay in 14 days")
are handled explicitly and tested.

**2. Uncertainty-preserving, risk-based confirmation.**
*Constraint:* at published code-switched error rates, raw transcript text is not sufficient
authority for a financial field.
*Decision:* parsing returns exactly one value **or an ambiguity set** — never an invented number.
`"two fifty"` yields ₦250, ₦2,500 and ₦250,000 and forces a question. Amounts, new payees and
low-margin entity matches require explicit confirmation before anything is issued.
*Tradeoff:* more conversational turns per invoice, in exchange for no silent financial errors.

**3. Tenant-scoped entity resolution with an explicit abstain state.**
*Constraint:* a mangled customer name has no reliable open-vocabulary reading.
*Decision:* resolve only against entities the business owns, accept only on a sufficient score
*margin*, and otherwise abstain and ask. This is an authorization boundary, not a similarity score.
*Tradeoff:* it cannot resolve a genuinely new customer, so "this is new" is a first-class outcome
rather than a failure — and a confidently wrong match is treated as worse than an abstention.

*Implementation detail rather than a design choice:* the backend voice gateway is **forced**, not
preferred — Intron authenticates the STT WebSocket with an `Authorization` header on the handshake,
which browser JavaScript cannot set. A useful side effect is that the API key never reaches the client.
When the stream fails recoverably, the gateway keeps the recording (≤60 s, in memory) and sends it to
Sahara's synchronous file endpoint instead of losing it; serverless hosts use that endpoint directly.

## Status

Honest separation of what runs today from what is still being built.

| Component | Status |
|---|---|
| Money engine — integer kobo, float-rejecting, half-up rounding | **Runs today** |
| Naira number grammar — ambiguity-preserving | **Runs today** |
| Invoice engine — extractor (Pidgin-aware), resolver, draft + questions | **Runs today** · Python engine with TypeScript port kept in parity |
| Tenant-scoped entity resolver — abstains on confusable names | **Runs today** |
| Web app — speak/type → editable transcript → check → create → invoices | **Runs today** (Next.js; Postgres in production, SQLite locally) |
| Intron Sahara streaming STT via the voice gateway | **Verified** against the live API |
| Intron Sahara sync file STT — gateway fallback and serverless upload path | **Verified** against the live API |
| Version-bound, idempotent invoice confirmation | **Runs today** |
| Speaker recorder — consent-gated, publishes no PII | **Built** (`/recorder.html`) |
| Evaluation scenario set — 30 scenarios, computed ground truth | **Built** |
| Benchmark harness — 4 models, WER/CER + invoice outcome, reproducible corpus | **Built** · results in `benchmarks/outputs/` |
| LLM extraction layer | **Not used** — extraction is deterministic by design |
| Intron TTS | **Not in the product** — used once to make a smoke-test clip |

`uv run pytest` → **115 tests**, and `cd web && pnpm test` → **112 tests**, with no network and no
credentials.

## Evaluation plan

Intron Sahara is benchmarked against Groq Whisper, Google Gemini and ElevenLabs Scribe on the same
audio, with one frozen normalisation policy fixed before any scoring. Full method, language-hint
table and commands: [`benchmarks/README.md`](benchmarks/README.md).

- **Track 1 — open corpora** — human-transcribed Nigerian speech (Nigerian Common Voice subset,
  NaijaS2ST dev, Nigerian Pidgin), rebuilt reproducibly by `benchmarks.load_data`. AfriSwitch is
  gated, so it is not used.
- **Track 3 — SautiBench code-switched recordings** — our own invoice-domain recordings, consented
  and de-identified, with human verbatim transcripts *and* ground-truth invoice JSON, scored for WER/CER
  and invoice outcome.
- **Track 2 — product probe** — recorded English briefs through the whole voice→invoice stack.
- **Adversarial safety set** (inside the scenarios) — near-duplicate customers, `"two fifty"` vs
  `"twelve-five"`, quantity/price transposition, mid-utterance self-correction.

Reported as a task-outcome taxonomy rather than a single score, because the row that matters is
*unsafe-incorrect-issuance* — a wrong invoice actually issued — and its target is zero.

The evaluation set is designed so grounding cannot flatter itself: **20% of scenarios use customers
that are deliberately not in the roster**, the roster contains confusable clusters
(*Adebayo Stores* / *Adebayo Ventures* / *Adeboye Stores*), and a confident wrong match will be
scored worse than an abstention.

## Ethics and inclusion

Microphone use is explicit and consent-gated. The recorder collects **no free-text field at all** —
speaker IDs are randomly assigned (`SPK-8EB2`), so no real name can reach the published dataset;
user-agent strings are bucketed to browser and OS family rather than stored raw, and timestamps are
day-precision. Every speaker agrees to public dataset hosting and may withdraw at any time. Every
business, customer and product in the evaluation set is invented — no real customer names, phone
numbers or account details are recorded. API keys stay server-side, forced by the protocol. The
product does not store recordings: the gateway holds audio in memory only (capped at 60 s) and clears
it when the session settles. No invoice is issued without the trader's explicit confirmation, and an
invoice is a request for payment, never a charge.

## Honesty

Nothing here is faked. Simulated components are labelled simulated. We make no claim of Nigerian
e-invoicing compliance, no claim of live fiscalization, and no claim about model superiority we
have not measured ourselves. Where Sahara loses to another model, we will report it.

## Documentation

| Document | Contents |
|---|---|
| [`docs/quickstart.md`](docs/quickstart.md) | Clone to passing tests in two minutes |
| [`docs/research.md`](docs/research.md) | Verified API findings, each marked observed or documented |
| [`docs/recording-protocol.md`](docs/recording-protocol.md) | How the evaluation set is collected, and consent |
| [`docs/repo-hygiene.md`](docs/repo-hygiene.md) | Contributor-list cleanup |
| [`docs/sautice-stt-research-paper.md`](docs/sautice-stt-research-paper.md) | 3-page product-centric research report on the STT benchmark |
| [`design/design-plan.md`](design/design-plan.md) | Visual identity and its rationale |
