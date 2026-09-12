# SautiBench — recording protocol

**Live recorder:** <https://harystyleseze.github.io/sautice-recorder/>
Works on any phone or laptop browser. Nothing is uploaded; the speaker downloads a `.zip` and
sends it back.

## Why the cards give facts, not scripts

Read speech is not code-switched speech. If we hand someone a written Yoruba–English sentence,
they perform it — the switch points land where the writer put them, not where a trader's would.

So each card states **the facts of a sale** and asks the speaker to say it **their own way**.
We then transcribe what they actually said. The ground-truth *invoice* is authored up front;
the ground-truth *transcript* is produced afterwards from the audio.

This costs us a transcription pass and buys genuinely natural switching, which is the thing the
competition is actually about.

## Target

| | |
|---|---|
| Speakers | 3–5, at least one each for Yoruba, Igbo, Hausa, Pidgin |
| Cards per speaker | 30 |
| Expected yield | 90–150 clips, ~8–20 s each |
| Time per speaker | ~20 minutes |

Every speaker records **the same 30 cards**, so the same invoice appears across speakers and
languages. That is what lets us compare a model's behaviour across language pairs while holding
the underlying transaction constant.

## What the set deliberately contains

| Property | Count | Why it is there |
|---|---|---|
| Out-of-roster customers | 6 / 30 (20%) | The system must say "new customer", not snap to the nearest known name. Without these the grounding ablation is rigged. |
| Out-of-roster product | 1 | Same, for the catalogue. |
| Confusable customers | 4 | *Adebayo Stores* / *Adebayo Ventures* / *Adeboye Stores* all exist in the roster. |
| Confusable products | 2 | Dangote / BUA / Lafarge cement; 12 mm vs 16 mm rod. |
| Ambiguous numbers (`MUST_ASK`) | 2 | *"twenty five"*, *"two fifty"*. Correct behaviour is a question, **not** a guess. |
| Self-correction | 1 | *"five bags — no, no, make am fifteen"*. The retracted value must not survive. |
| Transposition risk | 1 | Price stated before quantity. |
| Native numerals | 1 | Speaker invited to use a Yoruba/Igbo/Hausa numeral if natural. |
| Price overrides | 3 | Spoken price differs from the catalogue price; the spoken one must win. |
| Amount range | — | ₦1,800 to ₦580,000 |

## Consent

Five checkboxes are enforced in the UI — the Start button stays disabled until all five plus a
pseudonym are supplied (verified by test, not by assumption). They cover: age 18+, research use,
**public HuggingFace hosting under an open licence**, a commitment to say no real customer names,
phone numbers, addresses or account details, and the right to withdraw before or after
publication.

Captured per clip: pseudonym, language pair, device, environment, capture sample rate, duration,
user agent, timestamp, consent version. **No real names.** Every business, customer and product
in the scenario set is invented.

## What to send speakers

> We're testing how well speech AI understands the way Nigerians actually talk business.
>
> Open this on your phone: <https://harystyleseze.github.io/sautice-recorder/>
>
> You'll get 30 cards. Each one gives you the facts of a sale — **it's not a script**.
> Say it the way you'd really say it to your own staff, mixing English with Yoruba / Igbo /
> Hausa / Pidgin exactly as you normally would. Don't try to speak "properly" — natural is
> what we need. Takes about 20 minutes.
>
> At the end, tap download and send me the file.

## After collection

1. Unzip into `benchmarks/data/sautibench/audio/<speaker>/`.
2. Transcribe each clip verbatim (including fillers and self-corrections) → ground-truth transcript.
3. Validate: does the scenario's authored invoice still match what the speaker actually said?
   If a speaker changed a number, **the audio wins** — update the expected invoice or drop the clip,
   and record the decision.
4. Publish to HuggingFace with the manifest, licence and consent record.
