# UX decisions

How the Sautice trader interface is put together, and why. This is the UI/UX
companion to the transcription-reliability and invoice-flow work; it preserves
those fixes and adds no backend rewrite.

## The one workflow: Speak → Check → Create

A trader lands on **Make an invoice** and sees one obvious next action. There is no
language-selection wall and no dashboard. The task is always:

1. **Speak** (or **Type instead**) a sale in their own words.
2. **Check** a plain-language draft; answer any one specific question; correct any
   field.
3. **Create** the invoice with an explicit tap, then **View / Share / Download**.

Both input paths reach the *same* review, so the task completes even when the
microphone is unavailable — which also makes the flow demonstrable without a device.

## Language: interface vs speech are separate

The **interface** is simple English. The **speech language** is a labelled choice
shown in full ("Pidgin + English", "Yoruba + English", …); the wire codes
`pcm`/`yo`/`ig`/`ha` never surface. No national flags are used as language labels.
A simple-English interface can transcribe Pidgin–English or Yoruba–English. Pidgin
*interface* wording was intentionally **not** shipped, because a half-translated
selector would be worse than an honest single language — that remains a reviewed
follow-up.

## Visual semantics: a clear invoice book, no secret code

Built on the repository's invoice-book identity (white sheets on paper, dark ink,
aligned amounts, a rule above the total). Status is never carried by colour alone:

- **Green "Invoice created" / "Final"** badges carry a word, not just a hue.
- **Ochre "said/list"** tags on a price say where the number came from (a price you
  spoke, or the catalogue) — with a text label and a tooltip.
- **Red** is reserved for the total rule, destructive/error cues, and the recording
  indicator, which always sits beside the word "Stop recording".
- Automatic extraction is **never** labelled "Checked"; the reviewer checks.

## Correction is the point

The standout interaction is *change a field and watch a trustworthy total update*.
Every figure is recomputed by the Python money engine on the server — never in the
browser — so a corrected price yields a correct total, not a plausible-looking one.
Confusable names ("Musa Hardware" vs "Musa & Brothers") become a **question** with
the real candidates; an unknown name is offered as **new**, never snapped. An
ambiguous amount ("two fifty") asks rather than guesses. No invented confidence
percentages, no preselected "correct" answer.

## Recovery is honest

Error wording states the problem and the way forward, and never blames the speaker
("We couldn't use this recording. Please record again or type the details."). A lost
mic or connection offers **Record again** and **Type instead**. Because raw audio
isn't retained for a byte-identical replay, the UI does **not** promise "retry this
recording" — it offers an honest re-record or the typing path. Creation is
idempotent: a repeated confirm returns the original invoice, so a double-tap or a
lost response cannot create a duplicate.

## Trust and truthful state

- "Invoice created" appears only after the server confirms persistence.
- An invoice is a **request for payment** — never labelled "receipt", "paid", or
  "payment received".
- **Share** opens the native share sheet (or copies a link); the copy is explicit
  that opening a composer is not proof of delivery.
- Interim words show under "Words heard so far", a provisional label — no fabricated
  word-by-word captions, progress percentages, or completion-time promises.
- The mic meter reflects real input; it is not proof of a provider connection.

## Accessibility decisions

- Semantic `header`/`nav`/`main`/`h1`, real `button`/`label`/`fieldset`/`legend`,
  a skip link, and `aria-current` on the active nav item.
- Persistent visible labels (placeholders are examples, not labels). Status changes
  announce through `aria-live="polite"` without stealing focus.
- Contrast tokens fixed at the source (see `docs/ux-validation.md`): a dedicated
  `--edge` for control borders (the decorative `--carbon` fails as a control edge),
  a darker `--query` and `--ink-faint`, and a solid `--danger-solid` so the Stop
  button's white label passes in both themes.
- Touch targets: the primary controls keep the 52px button height; secondary
  controls aim for ≥44–48px. Reduced motion is honoured; the recording pulse stops.
- Line items become labelled cards below 460px so every amount stays fully visible
  (no ellipsised money, no horizontal page scroll).

## Component structure

An app shell (`layout.tsx` + `Nav.tsx`), the compose+record screen (`page.tsx`,
which owns the session state machine and mic/WS resources behind the existing
hooks), the review/correction/confirm component (`DraftReview.tsx`), the printable
invoice (`invoice/[id]`), the invoices list (`invoices`), and Help. The active
draft version is tracked so a stale response cannot overwrite a current edit, and
confirmation is bound to that version.
