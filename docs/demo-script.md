# Judge demo script (about 3 minutes)

Uses the implemented app only. Synthetic business details throughout. A fluent
speaker should do the spoken take in a tested language pair; the typed take is the
reliable fallback if the room is loud or a device mic is unavailable.

## 0. Setup (before the room)

```bash
cd web && npm run dev
```
Open http://localhost:3000 in Chrome (or the deployed URL). `web/.env` holds
`INTRON_API_KEY`; the key never reaches the browser.

## 1. Understand the product (10s)

Land on **Make an invoice**. One heading, one example, one obvious action. Say:
"A trader makes an invoice by speaking — and always checks it before it's created."

## 2. Speak a sale (30s)

Tap **Start speaking**, allow the mic, and say a natural sale in the chosen pair,
e.g. *"Adebayo Stores bought five bags of cement at twelve thousand five hundred
naira each."* Tap **Stop recording**. Show the real Sahara transcript appear under
**Words heard so far**, then the final. Tap **Check the details**.

> If the room is noisy, use **Type instead** and type the same sentence. Same review.

## 3. Check the money (20s)

On **Check your invoice**, point out: customer resolved to Adebayo Stores; Dangote
Cement, 5 × ₦12,500; the **said** tag showing the price came from what was spoken;
total **₦62,500** — computed by the money engine, not the model.

## 4. Correct a field, watch the total (20s) — the standout

Tap **Change** on the line, set the price to ₦13,000, **Apply**. The total updates to
**₦65,000** immediately, recomputed on the server. "The number you see is always the
number the engine calculated."

## 5. Show a real clarification (25s)

Start over and speak/type *"Musa bought two buckets of paint at eight thousand naira
each."* Sautice asks **"Which customer did you mean?"** — Musa Hardware vs Musa &
Brothers — and keeps the rest of the draft. Pick one. "It asks instead of guessing."

## 6. Create and retrieve (25s)

Tap **Create invoice** → **Invoice created**, INV-xxxxx, "a request for payment — not
a receipt." Tap **View invoice** (printable, Save-as-PDF) or **Share invoice**. Go to
**Invoices** and show it in the list; search by customer.

## 7. Recover gracefully (20s)

Deny the mic (or pull the network mid-record). Show the honest message — "The
connection stopped. Please record again or type the details." — with **Record again**
and **Type instead**. No lost draft, and a double-tap of Create never makes a
duplicate (idempotent issuance).

## Close (10s)

"Speak or type, check, correct, create, retrieve — with the money always trustworthy
and nothing faked." Mention the benchmark work lives in the supporting material, not
in the trader's screen.

## Do / don't

- **Do** use synthetic customers, label any pre-recorded fallback footage.
- **Don't** show debug controls, model stats, fake payment/receipt states, or
  celebratory effects in the trader UI.
