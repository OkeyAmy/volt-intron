# UX validation

What was actually checked, and what was not. Nothing here is a full accessibility
certification or a study of real traders — those remain open.

## End-to-end flow (driven in a real browser against the dev server)

Using the **Type instead** path (both input paths reach the same review, so the
task is exercisable without a microphone):

| Step | Result |
|---|---|
| Start screen | One heading, one example, "Start speaking" + "Type instead", expectation line. |
| Type a sale ("Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each") → **Check the details** | Draft resolved: Adebayo Stores, Dangote Cement, 5 × ₦12,500, total **₦62,500**, ready. |
| **Change** the unit price to ₦13,000 → Apply | Total recomputed **server-side** to **₦65,000** (5 × 13,000); the "said" tag became a "corrected" price. |
| **Create invoice** | "Invoice created — INV-00002 is saved. It's a request for payment — not a receipt." View / Share / Create another. |
| Clarification ("Musa bought two buckets of paint…") | Customer stays "to confirm" with **"Which customer did you mean?"** (Musa Hardware vs Musa & Brothers); the rest of the draft is preserved. |
| **Invoices** list | Real issued invoices, newest first, with a working customer/number search. |
| **Help** | Task-adjacent guidance; no jargon. |

The standout interaction — *correct a field and watch a trustworthy total update* —
is confirmed: every figure comes from the Python money engine, recomputed on each
edit; the browser never calculates a total.

Backend safeguards were verified over HTTP earlier: idempotent issuance (a repeat
confirm returns the original invoice), version-bound confirmation (a stale draft
version returns 409), and confusable-name questions.

## Contrast (WCAG 1.4.3 / 1.4.11), fixed at the token source

Computed from the checked-in hex pairs with relative luminance; pass/fail on
unrounded values. Fixes live in `design/tokens.css` (and its synced web copy):

| Pair | Before | After | Threshold |
|---|---:|---:|---|
| `--ink-faint` on leaf (light) | 3.19:1 | **5.41:1** (`#646A7A`) | 4.5:1 text |
| `--query` text on `--query-bg` (light) | 3.54:1 | **5.64:1** (`#80580D`) | 4.5:1 text |
| control border on leaf (light) | 1.47:1 (`--carbon`) | **3.89:1** (new `--edge` `#858176`) | 3:1 non-text |
| `--ink-faint` on leaf (dark) | 3.87:1 | **5.33:1** (`#8B93A5`) | 4.5:1 text |
| Stop-button label (white) on red | 3.03:1 (dark `--tally`) | **5.88:1** (solid `--danger-solid` `#C8102E`) | 4.5:1 text |
| control border on leaf (dark) | — | **3.58:1** (`--edge` `#6B7590`) | 3:1 non-text |

`--carbon` is kept only for decorative rules; anything that identifies an input or
control uses `--edge`. Core brand pairs already pass (ink on leaf 15.6:1, primary
button 15.6:1, settled 5.25:1).

## Accessibility checks performed

- **Semantics/keyboard**: `header`/`nav`/`main`/`h1`, real buttons and `label`s,
  `fieldset`/`legend` for questions, a skip link, `aria-current` on the active nav,
  `aria-live="polite"` status region, `aria-expanded` on the row "Change" toggle.
  Focus outlines use the `--focus` token throughout.
- **Reflow (1.4.10)**: at **320px** the line items become labelled cards with every
  amount visible; no horizontal page scroll. Verified at 320 and desktop.
- **Reduced motion**: `prefers-reduced-motion` disables transitions and the
  recording pulse; status text stays visible.
- **Colour independence**: status carries a word ("Invoice created", "Issued",
  "said"/"list", "Stop recording"), never colour alone.
- **Console**: no errors on the exercised screens.

## Automated gates

- Python: **103 tests** pass (`PYTHONPATH=src python -m pytest tests`).
- Web: `npm run build` succeeds, `npm run lint` clean, `npm run typecheck` 0 errors,
  `npm test` 54 pass.

## Not verified / open

- **Real-microphone capture** on a physical device — the test browser grants no mic;
  the mic-denied error path does render. Speaking uses the same reviewed path as
  typing, verified live against Sahara earlier in the reliability work.
- **A formal automated a11y scan** (axe) and a **real-trader usability round** were
  not run here. The accessibility work targets WCAG 2.2 AA for the delivered scope
  but is not a certification.
- **Performance**: no lab/field Core Web Vitals capture in this pass.
- **Pidgin interface locale**: intentionally not shipped (see `ux-decisions.md`).

## Screens captured during this pass

Start, review (ready), price-correction updating the total, invoice created, the
invoices list, Help, and the 320px labelled-card review. (Screenshots were taken in
the session; attach them to the submission deck.)
