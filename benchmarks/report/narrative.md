# Report prose (no numbers here — every figure is injected from results.json)

## summary

Sautice turns a spoken, code-switched sale into a checked invoice. We compare Intron Sahara with three other speech models on two kinds of audio: open, human-transcribed Nigerian corpora, and our own consented recordings of traders' invoice requests spoken in Pidgin, Yoruba, Igbo or Hausa mixed with English. Beyond word and character error rates we score the downstream task: whether each transcript, fed through the same deterministic invoice engine, produces the correct invoice total.

TO FILL AFTER THE FINAL RUN: two or three sentences stating which model led on each track and language, citing only the tables below.

## models

- **Intron Sahara** — built for African accents with dedicated code-switched language codes; requires server-side key handling (header-authenticated WebSocket) and has per-second credit cost.
- **Groq Whisper** — fast, widely used global baseline; no Pidgin code and the API rejects Igbo, so those clips run without a language hint.
- **Google Gemini** — general multimodal model prompted to transcribe verbatim; flexible, but a prompted LLM can paraphrase or normalise numbers.
- **ElevenLabs Scribe** — commercial transcription API; documents Igbo and Hausa support, accepts Yoruba, and rejects a Pidgin code, so Pidgin clips run without a hint.

## data

Preprocessing is identical for every model: audio is resampled to 16 kHz mono PCM16 WAV before any call, and the same file bytes are sent to every provider (results are cached by audio hash, so no clip is transcribed twice). Code-switched recordings come from the consent recorder, were made by adult speakers who ticked all five consent items, and are identified only by random speaker IDs. Reference transcripts for our recordings were typed by speakers of each language following a written convention and were never pre-filled from any model.

## metrics

- **WER and CER** (jiwer) are the standard, comparable measures of transcription accuracy; CER is reported because African-language orthography and tone marks make word boundaries and spelling variants costly under WER alone.
- **Normalisation** is frozen before scoring: whisper-normalizer for English, a basic normaliser that removes diacritics for other languages, plus inaudible-tag and filler removal. "Basic" WER is shown alongside as a lighter-normalisation check.
- **Invoice outcome** is the metric that matters for this product: a transcript is run through the unchanged Sautice engine and classed as exact, off by at most ten percent, wrong by more than ten percent, or blocked (the engine asked a question instead of guessing). A fluent transcript that turns "sixty-four thousand five hundred" into "six hundred and forty-five" is a serious error even when WER looks small.
- **Reference ceiling**: the human reference is also run through the engine, and the conditional column counts only clips where the reference itself yields the exact invoice, separating speech-recognition errors from engine limits.

## findings

TO FILL AFTER THE FINAL RUN, from `build_report --examples`: for each model and language, one strength and one weakness observed in the transcripts (for example handling of Pidgin particles, Yoruba tone marks, spoken money, product and customer names). No claim without an example in per_cell.jsonl.

## limitations

- Our code-switched set is a controlled, consented **read-speech** benchmark of invoice requests: speakers phrase each card in their own words, but it is not spontaneous market conversation, and the number of speakers is small.
- Accents are Nigerian only; results do not transfer to other Sahara language pairs without new data.
- Language hints differ by provider because each API supports different codes; each model was run in its best documented configuration, which is not hint-for-hint identical.
- Track 1 corpora are open datasets whose reference transcripts we did not create; some sentences may have appeared in model training data.
- Responsible data use: recordings were sent to third-party speech APIs only for this benchmark and only with speakers' consent; published clips carry no names, and a speaker can withdraw by their random ID.
