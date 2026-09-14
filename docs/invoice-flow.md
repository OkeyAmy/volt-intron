# Invoice flow: speech → draft → clarification → confirmation → invoice

The recorder's transcript is only the first step. This is the flow that turns it
into a real, stored invoice.

```
speech ─▶ Sahara transcript ─▶ structured intent ─▶ computed draft ─▶ questions
                                                          │               │
                                                   (answer questions) ◀───┘
                                                          ▼
                                    explicit confirmation ─▶ stored invoice ─▶ printable view
```

## Where each decision is made

- **Extraction** (transcript → intent): `src/sautice/invoice/extract.py`, a
  conservative heuristic. It recognises the common shape of a spoken sale and
  leaves anything uncertain empty. An LLM (Groq) extractor can replace it by passing
  a pre-built `intent` to the bridge; that path is an unverified seam, and the
  heuristic is the default.
- **Resolution and computation** (the authoritative core):
  `src/sautice/invoice/{roster,executor}.py`.
  - Names resolve against the workspace roster. A single clear match resolves; a
    confusable cluster (Adebayo Stores vs Adebayo Ventures, Musa Hardware vs
    Musa & Brothers) stays **ambiguous and becomes a question**; an unrecognised
    name is offered as a **new** entity, never snapped to the nearest one.
  - Every figure is an integer-kobo `Money` value computed here — never in the LLM
    or the browser. A price spoken in the sentence overrides the catalogue price and
    is labelled `spoken`. An ambiguous amount ("two fifty") becomes a price question
    rather than a guess.
  - The draft is `ready` only when there are no open questions.
- **The bridge**: `src/sautice/bridge.py` — one JSON request on stdin, one JSON
  response on stdout. Node invokes it (`web/src/lib/invoice/bridge.ts`) as a
  short-lived subprocess: no shell, no data in argv, bounded by a timeout and an
  output cap. This keeps the Python money logic authoritative without porting it.
- **Persistence and issuance**: `web/src/lib/invoice/store.ts` on `node:sqlite`.
  - Drafts are versioned; refining a draft bumps the version.
  - Confirmation is bound to `(draftId, version)`. If the draft changed after review
    the version no longer matches and confirmation returns **409** so the reviewer
    sees the new numbers first. Neither a transcript nor a model response can bypass
    this control — only an explicit confirm call issues.
  - Issuance is **idempotent** on an idempotency key: a double-click or retry returns
    the original invoice, never a second one. Each issue writes an audit row.
- **API** (`web/src/app/api/invoice/*`): `POST /draft` (create/refine),
  `POST /confirm` (issue), `GET /[id]` (fetch). **UI**: `web/src/app/page.tsx`
  (recorder) → `DraftReview.tsx` (questions + confirm) → `invoice/[id]/page.tsx`
  (printable, Save-as-PDF via the browser print dialog).

## Verified

- 18 Python tests in `tests/test_invoice.py` (resolution, extraction, money
  computation, ambiguity → questions, new-entity handling); 101 Python tests total.
- The full HTTP flow was driven against the dev server: an ambiguous "Musa" draft
  (₦62,500, one customer question) → answered to Musa Hardware → **INV-00001** issued
  → a repeat confirm returned the same invoice (idempotent) → the invoice page
  rendered. A wrong-version confirm returned 409.

## Deliberately out of scope

Discounts/VAT beyond an explicit statement, multi-workspace onboarding, and the LLM
extractor's live verification. This is an invoice **prototype** — not FIRS/NRS
fiscalisation, payment settlement, or regulatory certification.

## Configuration

- `SAUTICE_PYTHON` — python executable for the bridge (default `python`).
- `SAUTICE_ROOT` — repo root, if not inferable from the process cwd.
- `SAUTICE_DB` — SQLite file path (default `web/.data/sautice.db`). **Must be on a
  persistent volume in production**, not an ephemeral container filesystem.
- `SAUTICE_ROSTER` — roster JSON path (default: the bundled demo roster).
