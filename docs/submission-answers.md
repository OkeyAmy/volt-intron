# Submission form answers

Drafts for `submissions/form1.md`, each within its stated limit. Every claim traces to the README,
`docs/research.md`, or a passing test. **Re-check the status table before submitting** — anything
here written as built must still be built on the day.

---

### Solution Title
`Sautice — voice-to-invoice for Nigerian SMEs`

---

### Q1 · The problem (~50 words)

Nigerian traders speak business in mixed language — *"Abeg invoice Adebayo Stores, five bags,
twelve-five each"* — switching between English and Yoruba, Igbo, Hausa or Pidgin mid-sentence.
Typing that is slower than a carbon-copy book, so sales stay undigitised. Voice should fix it, but
code-switched recognition is too inaccurate for money.

---

### Q2 · Target users and scale (~50 words)

Nigerian SMEs and micro-traders who sell business-to-business and keep records on paper or by
voice. Nigeria has roughly 40 million MSMEs. Our design target is a mid-range Android phone on
mobile data in a noisy market, used by someone with no accounting software experience and no
appetite for forms.

---

### Q3 · How the app solves it (~50 words)

You speak naturally. Sautice transcribes through Intron Sahara, resolves the customer and products
against your own list, computes the money deterministically, and asks about anything genuinely
ambiguous instead of guessing. Nothing is issued until you confirm. The result is a numbered
invoice with an audit trail.

---

### Q4 · Does it support code-switching?

**Yes.** Yoruba–English, Igbo–English, Hausa–English and Pidgin–English, via Intron's code-switched
language codes `yo`, `ig`, `ha` and `pcm`.

---

### Q5 · Does it use the Sahara APIs?

**Yes.** Streaming STT at `wss://infer.voice.intron.io/stt/v1/stream` with
`use_language_asr_input` set to a code-switched code, and the synchronous file endpoint
(`/file/v1/upload/sync`) as a reliability fallback when the live socket drops. Both verified working
against the live API in production.

---

### Q6 · How is it agentic? (~50 words)

The transcript is not the output — it drives a task. The agent extracts a transaction, detects what
is missing or ambiguous, asks a clarifying question in the user's register, recomputes
deterministically, requires explicit confirmation, then issues an invoice with an audit trail.
The artefact is a financial document, not text.

---

### Q7 · Technical overview and tradeoffs (~250 words)

Code-switched African ASR is hard: our own pilot puts Sahara at 16.4% WER overall but 38.9% on
Nigerian Pidgin, and the two other models we tested fare worse on Nigerian speech (Whisper 66.9% on
Nigerian-accented clips). So the engineering problem is not transcription — it is making a financial
action safe on top of an unreliable transcript. Three decisions follow, each as constraint, decision,
cost.

**No LLM in the money path — heuristic extraction with a typed action boundary.** A hallucinated
quantity or price is a wrong invoice, so the deployed extractor is a deterministic parser that emits
typed actions as data; a separate executor validates and applies them and computes every total. Money
is an integer count of kobo that rejects floats, because float arithmetic loses fractions of a kobo.
The cost is autonomy — a novel phrasing becomes a clarification, not an improvisation — which for
money we consider the right trade.

**Uncertainty-preserving confirmation.** Our parser returns one value or an ambiguity set, never an
invented number. *"Two fifty"* yields ₦250, ₦2,500 and ₦250,000 and forces a question; *"twelve-five"*
resolves cleanly to ₦12,500. Amounts and new payees require explicit confirmation. The cost is extra
turns, traded against silent financial errors.

**Tenant-scoped entity resolution with an abstain state.** A mangled customer name has no reliable
open-vocabulary reading, so we resolve only against entities the business owns, accept on a score
margin, and otherwise ask. This is an authorization boundary, not similarity scoring. The cost is
that genuinely new customers cannot be resolved — so "this is new" is a first-class outcome, and a
confident wrong match is treated as worse than abstaining.

---

### Q8 · Ethics and inclusion (~100 words)

Microphone use is explicit and consent-gated. Our recorder collects no free-text field at all —
speaker IDs are randomly assigned, so no real name can reach the published dataset. User-agent
strings are bucketed to browser and OS family, and timestamps are day-precision, because a handful
of speakers plus a fingerprint is not anonymous. Speakers agree to public hosting and may withdraw
anytime. Every business, customer and product in our evaluation set is invented. API keys stay
server-side. Raw audio is not retained by default. Uncertainty is shown rather than hidden, and no
financial action happens without confirmation.

---

### Website / Solution URL
`https://sautice-voice1.onrender.com` (live voice app; container host running the WS gateway + Neon Postgres)

### Solution Description (short blurb)
Sautice turns a Nigerian trader's spoken, code-switched sale into a confirmed invoice. Speak
naturally in Yoruba/Igbo/Hausa/Pidgin mixed with English; Intron Sahara transcribes it, a
deterministic core resolves your customer and products and computes the money exactly, asks about
anything ambiguous, and issues a numbered invoice only after you confirm.

### Benchmark headline (real pilot, 68 clips, 3 models incl. Sahara)
Overall WER — **Sahara 16.4%**, ElevenLabs Scribe 17.0%, Whisper-large-v3-turbo 38.2%. Sahara leads
on the hardest Nigerian categories: Pidgin 38.9% vs Whisper 77.9%; Nigerian-accented 18.5% vs Whisper
66.9%. Zero catastrophic money errors across all models (the deterministic guard blocks bad transcripts
instead of issuing a wrong invoice). Full report: `benchmarks/outputs/pilot/results.json`.

### Links

| Field | Value |
|---|---|
| Website | https://sautice-voice1.onrender.com |
| Code | https://github.com/OkeyAmy/volt-intron |
| Demo video | **YOU must record** — ≤5 min, public/unlisted YouTube, must show code-switching (script: `docs/demo-script.md`) |
| Benchmark report | PDF generated from real data → host on Drive ("anyone with link") — see `docs/benchmark-report.html` |
| Benchmark audio (optional) | HuggingFace upload of the consented, de-identified pilot clips (optional) |
