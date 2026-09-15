# Submission form answers

Mirror of the draft in `submissions/form1.md`, each within its stated limit. Every claim traces to
code on this branch, a live API check, or a cited source. **Anything marked ⟨PENDING⟩ must be filled
from real results before submitting; never type a number that isn't in `benchmarks/outputs/`.**

---

### Solution Title
`Sautice — speak a sale in Pidgin, Yoruba, Igbo or Hausa mixed with English, get a checked invoice`

---

### Q1 · The problem (~50 words)

Nigerian traders sell in mixed speech — *"abeg put five bags Dangote for Adebayo, twelve-five
each"* — but invoicing tools need typing and English. Typing on a phone mid-sale is slow, and
misreading spoken money ("twelve-five" is ₦12,500, not ₦125) creates wrong invoices. Voice tools
built for monolingual English mishear code-switched speech and money.

---

### Q2 · Target users and scale (~50 words)

Owners and sales staff of Nigeria's micro and small businesses — starting with building-materials
and market traders who sell on credit and need invoices. Nigeria has 39.6 million MSMEs, 87.9% of
national employment (SMEDAN–NBS National MSME Survey 2021). The flow extends to other markets
Sahara's code-switched pairs cover.

Source: <https://www.nigerianstat.gov.ng/elibrary/read/966>

---

### Q3 · How the app solves it (~50 words)

The trader taps Start speaking and says the sale naturally. Intron Sahara transcribes the
code-switched speech; the trader can fix any word. A deterministic invoice engine matches the
customer and products, reads Nigerian money and quantities exactly, asks a clarifying question when
unsure, and creates a numbered, shareable, printable invoice after confirmation.

---

### Q4 · Does it support code-switching?

**Yes.** Pidgin–English (`pcm`), Yoruba–English (`yo`), Igbo–English (`ig`), Hausa–English (`ha`),
plus English, using Sahara's code-switched language codes (docs.voice.intron.io/docs/stt/supported-languages).

---

### Q5 · Does it use the Sahara APIs?

**Yes.** Streaming STT at `wss://infer.voice.intron.io/stt/v1/stream` with
`use_language_asr_input` set to a code-switched code, and the synchronous file endpoint
(`/file/v1/upload/sync`) as a reliability fallback when the live socket drops. Both verified working
against the live API in production.

---

### Q6 · How is it agentic? (~50 words)

The transcript drives an action: the agent extracts customer, items, quantities, prices and payment
terms, resolves them against the business's catalogue and customer list, computes totals in integer
kobo, asks targeted questions for ambiguity (e.g. "₦250, ₦2,500 or ₦250,000?"), and issues a
version-bound, idempotent invoice once the trader confirms.

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

No autonomous financial action: every invoice needs the trader's confirmation and is a payment
request, not a charge. Recordings are not stored by the app; the gateway keeps audio in memory only
(≤60 s) and clears it when the session settles. API keys stay server-side. Benchmark speakers gave
explicit five-point consent (18+, research use, public release, no real personal data, deletion on
request), are identified only by random IDs, and can withdraw by ID. Only consented clips were sent
to third-party ASR providers for benchmarking. Limits: few speakers and Nigerian accents only; some
providers lack Pidgin/Igbo support.

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
