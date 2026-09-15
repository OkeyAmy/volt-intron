# Reference transcription convention (Track 3)

A reference transcript is what the speaker **actually said**, typed by a person who
speaks that language. It is the ground truth every model is scored against, so it
must never come from a model.

## Rules

1. **Never copy or edit any ASR output** (Sahara, Whisper, Gemini, ElevenLabs, phone
   dictation). Listen and type from scratch. Pre-filling from a model biases the
   score toward that model.
2. **Verbatim, not the card.** Type the words spoken, even if they differ from the
   brief on the card (extra words, a correction such as "no, make am fifteen").
3. **Do not translate.** Keep every language as spoken: "Abeg put five bags Dangote
   cement for Adebayo Stores" stays exactly that.
4. **Pidgin spelling:** common everyday spelling — *abeg, wetin, dey, na, am, oya,
   sef, sabi, wahala, don, go, fit*.
5. **Yoruba / Igbo / Hausa:** standard orthography. Add tone marks and diacritics
   only if you are confident; scoring reports both with and without diacritics.
6. **Numbers and money:** write them as **words, the way they were said** —
   "twelve thousand five hundred naira", "twelve-five", "12.5k" said as
   "twelve point five k". Do not convert to digits.
7. **Names:** spell customers and products as on the roster card
   (e.g. *Adebayo Stores, Dangote Cement*), even if pronounced differently.
8. **Hesitations:** leave out "uh/um/eh". Keep repeated or corrected words.
9. **Unclear audio:** write `[inaudible]` for a word you cannot make out; do not guess.
10. **Punctuation:** optional; scoring ignores case and punctuation.

## The file

`benchmarks/data/sautibench/references.csv` — generate the rows, then fill them in:

```
uv run python -m benchmarks.run --codeswitch-template benchmarks/data/sautibench/recordings
```

| column | who fills it |
|---|---|
| `audio_file`, `scenario_id`, `language_pair` | generated |
| `reference_text` | first annotator (speaks the language) |
| `annotator` | first annotator's initials or random ID (no full names) |
| `check_text`, `check_annotator` | optional second annotator on ≥10% of clips, typed **without looking at** `reference_text`; used only to report agreement |
