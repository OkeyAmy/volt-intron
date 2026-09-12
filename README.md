# Sautice

**Voice-to-invoice for Nigerian SMEs — built for speech recognition that gets one word in three wrong.**

Entry for the [Sahara CodeSwitch Africa Challenge 2026](https://www.intron.io/compete/) ·
category *Fintech, Telco & Customer Experience*.

---

## The problem we actually set out to solve

Intron's Sahara v2.5 is the best code-switching speech model available for African languages, and
it publishes **34.3% average word error rate** on code-switched speech. Intron's own CEO puts it
plainly: *"roughly one word in three comes out wrong."* The independent
[AfriSwitch benchmark](https://huggingface.co/datasets/intronhealth/AfriSwitch) finds the best of
five systems averages 35.93% WER, with none below 24% on any language.

So the interesting question is not *"can we transcribe African code-switched speech?"*
It is:

> **What has to be true for a small business owner to trust a ~35%-WER transcript with their money?**

On our very first live call to the API, the system heard *"sixty-four thousand five hundred naira"*
as **"645 naira"** — a 100× error on a real invoice total. That single result shaped everything
in this repository.

## What we built

A voice agent that issues a real, validated invoice from naturally code-switched Nigerian speech
(Yoruba / Igbo / Hausa / Pidgin mixed with English) — and that is **correct even when the
transcript is not**, because it never trusts the transcript with a number.

Three mechanisms, each independently measured:

1. **Roster grounding** — customer and product mentions are resolved against the business's own
   closed list by phonetic + fuzzy match, turning open-vocabulary ASR error into closed-set
   resolution. Below threshold it asks; it never snaps to the nearest name.
2. **Naira number grammar** — a deterministic, tested parser for spoken Nigerian money.
   The language model proposes a value *and the verbatim span it heard*; the parser is
   authoritative. `"two fifty"` is treated as genuinely ambiguous and triggers a question.
3. **Risk-gated confirmation** — the model never computes a total and never writes to the
   database. Money fields require explicit confirmation before an invoice is issued.

## Status

Under active development for the 15 September 2026 deadline. See
[`docs/research.md`](docs/research.md) for verified API findings and
`docs/benchmark.md` for methodology (pre-registered before results).

## Honesty

Nothing here is faked. Simulated components are labelled simulated. We make no claim of Nigerian
e-invoicing compliance, no claim of live fiscalization, and no claim about model superiority we
have not measured ourselves. Where Sahara loses to another model, we report it.
