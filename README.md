<div align="center">
<img src="design/logo-ink.svg#gh-light-mode-only" alt="Sautice" height="34">
<img src="design/logo-light.svg#gh-dark-mode-only" alt="Sautice" height="34">

**Voice-to-invoice for Nigerian SMEs — designed for speech recognition that gets one word in three wrong.**

Entry for the [Sahara CodeSwitch Africa Challenge 2026](https://www.intron.io/compete/) ·
category *Fintech, Telco & Customer Experience*

[Quickstart](docs/quickstart.md) · [Research log](docs/research.md) · [Recording protocol](docs/recording-protocol.md)
</div>

---

## The problem

A Nigerian trader selling cement does not speak the way invoicing software expects. They say
*"Abeg invoice Adebayo Stores, five bags, twelve-five each"* — switching between English and
Yoruba, Igbo, Hausa or Pidgin inside a single sentence. Typing that into a form is slower than
writing it in a carbon-copy book, so most never digitise it at all.

Voice should solve this. The obstacle is that code-switched African speech recognition is not
accurate enough to trust with money.

## Why this is hard, in numbers

Intron's Sahara v2.5 is the strongest code-switching model available for African languages, and
it publishes **34.3% average word error rate** on code-switched speech (against 53.8% for Gemini
3.6). Intron's own CEO puts it plainly: *"roughly one word in three comes out wrong."* The
independent [AfriSwitch benchmark](https://huggingface.co/datasets/intronhealth/AfriSwitch) finds
the best of five systems averages **35.93% WER**, with none below 24% on any language.

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
on paper. Nigeria has roughly 40 million MSMEs. The design target is a mid-range Android phone on
mobile data in a noisy environment, operated by someone with no accounting software experience.

## How it works

The designed flow — speak naturally, and the system transcribes through Intron Sahara, resolves who
and what you meant against your own customer and product list, computes the money deterministically,
shows you what it understood, asks about anything it is unsure of, and issues the invoice only after
you confirm.

> **Built so far:** the deterministic money engine and the ambiguity-preserving number grammar, both
> tested and runnable today. The resolver, agent and invoice engine are still being built — see
> [Status](#status) for the line-by-line breakdown. Nothing in this README is written as working
> software unless that table says it is.

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
Browser ──PCM16──> voice gateway ──Bearer on handshake──> Intron Sahara STT
                                                              │
                                                          transcript
                                                              ▼
                              LLM emits TYPED ACTIONS AS DATA (strict JSON schema)
                                                              │
                                          deterministic executor validates + applies
                                                              ▼
                        naira number grammar  +  tenant-scoped entity resolution
                                                              ▼
                              money engine — integer kobo, no floats, half-up
                                                              ▼
                                  risk policy ⇒ ASK | PREVIEW | CONFIRM
                                                              ▼
                            issued invoice · PDF · audit event · Intron TTS reply
```

### Three design decisions, and what each one cost

Written as **constraint → decision → tradeoff**, so it is clear what was forced by a platform and
what was actually chosen.

**1. Deterministic financial core with a typed action boundary.**
*Constraint:* Groq's strict `json_schema` mode cannot be combined with tool-calling or streaming.
*Decision:* the model emits typed actions as **data**; a deterministic executor validates and
applies them. The model never computes a total. Money is an integer count of kobo that rejects
floats outright, because float arithmetic silently loses fractions of a kobo and produces a total
the business never agreed to.
*Tradeoff:* no autonomous multi-step tool loops. A novel request becomes a clarification rather
than an improvisation — less autonomy, bought back as auditability.

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

## Status

Honest separation of what runs today from what is still being built.

| Component | Status |
|---|---|
| Money engine — integer kobo, float-rejecting, half-up rounding | **Runs today** · 27 tests |
| Naira number grammar — ambiguity-preserving | **Runs today** · 51 tests |
| Intron STT streaming + TTS integration | **Verified working** against the live API |
| Speaker recorder — consent-gated, publishes no PII | **Live** |
| Evaluation scenario set — 30 scenarios, computed ground truth | **Built** |
| Design system and logo | **Built** |
| Invoice engine, state machine | Not built |
| Tenant-scoped entity resolver | Not built |
| Agent layer (Groq) | Not built |
| Benchmark harness and results | Not built |
| Web UI | Not built |

`uv run pytest` → **78 passed**, with no network and no credentials.

## Evaluation plan

Benchmarking Intron Sahara against additional speech models on the same audio, with one frozen
normalisation policy fixed before any scoring.

- **AfriSwitch** — real human code-switched speech, out-of-domain, comparable to published figures.
- **SautiBench** — our own invoice-domain recordings, consented and de-identified, with ground-truth
  transcripts *and* ground-truth invoice JSON. Planned as a pilot evaluation set, reported
  speaker-stratified.
- **Adversarial safety set** — near-duplicate customers, `"two fifty"` vs `"twelve-five"`,
  quantity/price transposition, mid-utterance self-correction.

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
numbers or account details are recorded. API keys stay server-side, forced by the protocol. Raw
audio is not retained by default in the product.

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
| [`design/design-plan.md`](design/design-plan.md) | Visual identity and its rationale |
