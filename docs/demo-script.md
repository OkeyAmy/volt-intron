# Judge demo script (≤ 5 minutes, must show real code-switching)

Uses the implemented app only, on the public Render deployment. Synthetic business
details throughout. **Every sentence below was run through the invoice engine on
2026-09-15 and produced the result stated** — do not improvise new phrasing on camera.
A fluent Pidgin speaker does the spoken takes; typing is the fallback for a noisy room.

## 0. Setup (before recording)

- Open `https://<render-url>/api/health` → `database: postgres`, `databaseReachable: true`,
  `apiKeyConfigured: true`. If not, fix the Render environment first.
- Open `https://<render-url>/` in Chrome on a phone or laptop. Speech language: **Pidgin + English**.
- Quiet room, phone close to the mouth. Screen-record the browser.

## 1. The problem, in one line (15s)

"Nigerian traders sell in mixed speech. Typing an invoice mid-sale is slow, and a misheard
amount is a wrong invoice. Sautice lets them just say it."

## 2. Speak a code-switched sale (45s)

Tap **Start speaking**, allow the mic, and say:

> *"Abeg, Adebayo Stores wan buy five bags of Dangote cement, twelve-five each."*

Tap **Stop recording**. The Sahara transcript lands in **Here's what we heard** — point out
the words are editable, and fix any misheard word by typing. Tap **Check the details**.

Expected: customer **Adebayo Stores**, **Dangote Cement 50kg ×5 at ₦12,500**, tag **said**,
total **₦62,500**, ready to create. "Pidgin opener, Pidgin verb, trader shorthand for
₦12,500 — and the total is computed by the engine, not guessed by a model."

## 3. Correct a field, watch the total (20s)

Tap **Change** on the line, set the price to **13000**, **Apply** → total **₦65,000**,
recomputed on the server.

## 4. It asks instead of guessing (60s)

**Tap Edit words**, replace the text with, and check:

> *"Musa buy two buckets emulsion paint at eight thousand naira each"*

Expected: **"Which customer did you mean by 'Musa'?"** — Musa Hardware | Musa & Brothers |
New customer. Pick **Musa Hardware**; the draft becomes ready (₦16,000).

Then:

> *"Adebayo Stores bought ten rolls of binding wire at two fifty each"*

Expected: **"What price — could mean ₦250, ₦2,500, ₦250,000?"** "A fluent model would
silently pick one. We ask, because it's money."

## 5. Create, share, retrieve (40s)

Back on the Adebayo Stores draft: **Create invoice** → **Invoice created**, INV-xxxxx and
the total. Tap **View invoice** (print / Save as PDF) and **Share invoice**. Open
**Invoices** and search "Adebayo".

## 6. Graceful failure (20s)

Deny the microphone once: a calm message with **Record again** and **Type instead**, and
nothing is lost. A double tap on **Create invoice** never makes a duplicate.

## 7. The benchmark, one slide (40s)

Show the benchmark PDF: four models on the same audio — Intron Sahara, Groq Whisper,
Gemini, ElevenLabs — word and character error rates by language, and the invoice outcome
on our consented code-switched recordings. Read only numbers that are on the slide.

## Close (10s)

"Say it the way you sell. Check it. Create it. The money is always the engine's, and it asks
when it isn't sure."

## Do / don't

- **Do** keep the whole video under 5 minutes, and upload as **unlisted or public** on YouTube.
- **Do** use only the sentences above (verified) and synthetic customers.
- **Don't** show debug controls, credit balances, or any number not produced live or in the report.
