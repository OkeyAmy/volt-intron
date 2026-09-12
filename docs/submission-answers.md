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
`use_language_asr_input` set to a code-switched code, the file endpoint as a fallback, and Intron
TTS for spoken replies. Verified working against the live API.

---

### Q6 · How is it agentic? (~50 words)

The transcript is not the output — it drives a task. The agent extracts a transaction, detects what
is missing or ambiguous, asks a clarifying question in the user's register, recomputes
deterministically, requires explicit confirmation, then issues an invoice with an audit trail.
The artefact is a financial document, not text.

---

### Q7 · Technical overview and tradeoffs (~250 words)

Code-switched African ASR is roughly 35% WER — Intron publishes 34.3% for Sahara v2.5, and the
AfriSwitch benchmark's best system averages 35.93%. So the engineering problem is not transcription.
It is making a financial action safe on top of an unreliable transcript. Three decisions follow,
each stated as constraint, decision and cost.

**Deterministic financial core with a typed action boundary.** Groq's strict JSON-schema mode cannot
be combined with tool-calling, which forced the safer shape: the model emits typed actions as data
and a deterministic executor validates and applies them. The model never computes a total. Money is
an integer count of kobo that rejects floats, because float arithmetic loses fractions of a kobo and
produces totals nobody agreed to. The cost is autonomy — a novel request becomes a clarification
rather than an improvisation.

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

### Links

| Field | Value |
|---|---|
| Demo video | *pending* — must show code-switching, ≤5 min, public or unlisted |
| Benchmark report | *pending* — hosted PDF, max 3 pages |
| Benchmark audio | *pending* — HuggingFace, consented and de-identified |
| Code | https://github.com/OkeyAmy/volt-intron |
