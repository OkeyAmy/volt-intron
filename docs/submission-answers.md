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

**Yes.** Sahara streaming STT (`wss://infer.voice.intron.io/stt/v1/stream`, `web/server.mts`) as the
live path, and Sahara synchronous file STT (`POST https://infer.voice.intron.io/file/v1/upload/sync`,
`web/src/lib/speech/intron-file.ts`) as the gateway's fallback and the serverless upload path.
Both verified with real recordings.

---

### Q6 · How is it agentic? (~50 words)

The transcript drives an action: the agent extracts customer, items, quantities, prices and payment
terms, resolves them against the business's catalogue and customer list, computes totals in integer
kobo, asks targeted questions for ambiguity (e.g. "₦250, ₦2,500 or ₦250,000?"), and issues a
version-bound, idempotent invoice once the trader confirms.

---

### Q7 · Technical overview and tradeoffs (~250 words)

**1. Deterministic money engine, not an LLM, for amounts.** Extraction, catalogue matching and naira
parsing are rule-based (Python engine with a tested TypeScript port) and every figure is integer
kobo. Tradeoff: less flexible phrasing than an LLM, but it never invents a price, and ambiguity
becomes a question instead of a silent error — the right failure mode for money.

**2. Server-side voice gateway.** Sahara authenticates its WebSocket with an `Authorization` header
that browsers cannot set, so a Node gateway (Next.js custom server + `ws`) holds the key and relays
16 kHz PCM16 captured by an AudioWorklet. Tradeoff: needs a persistent host (Render) rather than
pure serverless; on Vercel we fall back to record-then-upload.

**3. Streaming first, Sahara file API as fallback.** Live partials make speaking feel responsive;
when the stream fails recoverably (seen in production as a WebSocket FIN error through proxies) the
gateway keeps a bounded 60-second buffer and transcribes it with Sahara's sync file endpoint, so
the recording is not lost. Tradeoff: extra memory per session and a slower result when degraded.

**4. Human-in-the-loop, version-bound confirmation.** The trader sees and can edit the transcript,
reviews the draft, and confirms; confirmation is bound to the draft version and an idempotency key,
so a changed draft or a double tap cannot issue a wrong or duplicate invoice. Tradeoff: one more
tap, in exchange for trust.

**5. Postgres (Neon) in production, SQLite locally**, with typed "not configured" errors instead of
crashes.

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

### Links

| Field | Value |
|---|---|
| Website | ⟨PENDING: public Render URL⟩ |
| Demo video | ⟨PENDING⟩ — must show real code-switching, ≤5 min, public or unlisted |
| Benchmark report | ⟨PENDING⟩ — `benchmarks/report/build_report.py` output, hosted PDF, max 3 pages |
| Benchmark audio | ⟨PENDING⟩ — HuggingFace, consented and de-identified |
| Code | https://github.com/OkeyAmy/volt-intron |
