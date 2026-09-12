# Sautice — design plan

## Subject, audience, job

**Subject.** A voice agent that turns naturally code-switched Nigerian speech into an issued invoice.
**Audience.** A trader or small-business owner in Lagos on a mid-range Android phone, who speaks
Yoruba / Igbo / Hausa / Pidgin mixed with English. Secondarily: challenge judges from Wema Bank,
ARM, Branch International, and AI research labs.

**The design's real job** is not "look like a fintech app". It is:

> Make someone trust a machine with their money when the machine is working from a transcript
> that is roughly one word in three wrong.

Every visual decision below is answerable to that sentence.

## Where the visual language comes from

Nigerian traders already have an invoicing interface: the **carbonless duplicate invoice book**.
Ruled columns, ballpoint blue-black ink, a hard red rule above the total, a canary carbon copy
underneath, a perforated edge. It is the thing we are replacing, and its vocabulary is one the
user already reads fluently — so we borrow the parts that *carry meaning* and drop the nostalgia.

The single idea we take from it: **the ruled line is a status, not a decoration.**

| Line under a field | Means |
|---|---|
| Solid ink rule | Resolved and confirmed |
| Dashed rule | Heard, but not certain — check this |
| Open gap in the rule | The agent is asking you about this right now |
| **Red rule** | Money is being decided on the line below |

That is structure encoding information rather than ornamenting it, and it is unique to this
product because it is unique to this problem: uncertainty has to be *visible* at the field level.

## Tokens

**Color** — six values, one accent used sparingly.

| Name | Light | Role |
|---|---|---|
| `ink` | `#16233F` | Ballpoint blue-black. Text, wordmark, resolved rules. |
| `paper` | `#F7F6F2` | Page ground. Paper, not cream — no warm-clay cast. |
| `leaf` | `#FFFFFF` | Raised surfaces (the sheet you are writing on). |
| `carbon` | `#D9D5CA` | Rules, borders, dividers, muted text at `#6A6E78`. |
| `settled` | `#1F7A5C` | Confirmed. Deep, not acid. |
| `query` | `#A9761A` | Needs checking. Ochre, not alarm. |
| `tally` | `#C8102E` | **The red total rule.** Also destructive/error. Nothing else. |

Dark mode inverts ground and ink (`#0E1526` ground, `#EEF1F6` text); accents hold their hue and
lift ~12% in lightness. Both themes are authored; neither is an afterthought.

**Type** — one family. **Archivo** (variable). Chosen for genuinely excellent tabular figures,
which matters more here than in most products because the screen is mostly amounts. No second
display face: weight and width carry the hierarchy instead.

Scale (1.25): 12 / 14 / 16 / 20 / 25 / 31 / 39. Body 16/1.55. Money always
`font-variant-numeric: tabular-nums` so digits align down a column and a changed digit is visible.

**Layout.** Single column, max 34rem, left-aligned. Phone-first and phone-shaped even on desktop,
because that is the real device. Content sits on a `leaf` sheet over `paper`, with the sheet
running full-bleed on small screens.

```
┌──────────────────────────────┐
│ ◟◞◟─────  Sautice            │   wordmark: waveform resolving into a rule
│                              │
│  Adebayo Stores              │
│  ─────────────────────────── │   solid  = confirmed
│                              │
│  5 × Dangote Cement 50kg     │
│  ─────────────────────────── │
│                              │
│  ₦12,500 each                │
│  ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ ‑ │   dashed = check this
│                              │
│  Delivery        ₦2,000      │
│  ─────────────────────────── │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━ │   RED rule: money below
│  Total          ₦64,500      │
└──────────────────────────────┘
```

**Principles.**
1. Uncertainty is visible at the field level, never hidden behind a spinner.
2. One bold move: the red rule above the total. Everything else stays quiet.
3. Motion only answers an action — a field resolving, a question arriving. No scroll reveals.
4. Never show a number the system cannot justify.

## Review against the brief — what I changed after a first pass

- **Dropped near-black + green.** My first recorder screen was `#0f1214` with a `#2fb96b` accent —
  which is the generic "dark UI with one bright accent" default, and reads as any dev tool.
  Replaced with the ink-on-paper system above, which is specific to invoicing.
- **Rejected warm cream + serif + terracotta** outright: it is the most common generated look, and
  terracotta in particular is a tell.
- **No monospace for labels.** Tabular figures in the text face do the alignment job that a mono
  face is usually hired for, without the "technical product" costume.
- **No ALL-CAPS eyebrows, no `·`-joined meta strings, no `→` on buttons.**
- **Resisted numbered step markers** in the recorder even though it is multi-step: the progress is
  already carried by a counter and a bar, and numbering every card would be decoration.
- **Green is not the primary accent.** In a money product green reads as "profit"; here it means
  exactly one thing — *this field is confirmed* — so it cannot also be the brand colour.

## Logo

A waveform that flattens into a ruled line, ending on a short red tally stroke.

Left: speech, unsettled. Right: the record, settled. The red stroke is the total rule. It is the
product thesis in one mark, and it survives being 16px in a browser tab because it is four
strokes and a tick.

## Build critique

Things caught by looking at the rendered result rather than the code:

- **First logo attempt failed on dark backgrounds.** `currentColor` cannot be inherited through
  `<img src="logo.svg">`, so the mark rendered black on navy — invisible. Fixed by inlining the
  SVG where theme-awareness matters and shipping fixed-colour `-ink` / `-light` variants for
  `<img>` use.
- **Three logo directions were rendered at 16–96px and compared** before choosing. The decaying
  three-oscillation version muddied at small sizes; the wave-only version was cleanest but lost
  the invoice meaning entirely. The chosen mark keeps one clear oscillation, a long settled run,
  and the red rule under the settled half only.
- **Favicon data URI broke the markup.** The SVG's double quotes escaped the `href="..."`
  attribute and dumped `%0A %0A` into the page. Fixed by collapsing whitespace and switching the
  SVG to single quotes before percent-encoding.
- **Removed two middle-dot meta strings** (`SPK-8EB2 · yo-en · market`, `30 clips · 240 seconds`)
  after the first screenshot. Both were the generic template chrome the brief warns about; the
  first became the speaker ID alone, the second a plain sentence.
- **Dropped a redundant chip.** Cards were showing both `out of roster` and `new customer`, which
  say the same thing. Kept the one written in the user's language.
