# Comparing Three Commercial Speech-to-Text Systems for Voice-Driven Invoicing in Nigeria

**Sautice Engineering.** All figures are drawn from the committed `benchmarks/outputs/pilot` snapshot of the Volt-Intron benchmarking repository (metrics version 2.0). Raw transcripts and scoring code ship with the repository, so every number in this report is reproducible.

## Abstract

Sautice turns a short spoken order, such as a request for building materials with a price and a customer name, into a structured invoice. The choice of speech-to-text (STT) provider therefore affects billing accuracy directly, and the decision cannot be made on open-corpus word error rate alone. This report evaluates ElevenLabs (`scribe_v1`), Groq (`whisper-large-v3-turbo`), and Intron Sahara on a fixed set of 68 recordings covering Nigerian English, Nigerian Pidgin, Hausa, Igbo, and Yoruba. Two separate measurements are reported. Track 1 is a conventional ASR comparison under a frozen normalization scheme, in the style of an open leaderboard. Track 2 is an end-to-end probe of the probability that a provider turns a dictated brief into the correct invoice; it combines ASR errors with the behavior of Sautice's own parser and is not comparable outside the product.

On Track 1, Intron reaches the lowest word error rate at 16.4% (95% CI ±5.5; character error rate 7.2%), ahead of ElevenLabs at 18.5% (±7.6; CER 7.8%) and Groq at 38.2% (±10.9; CER 18.8%). On Track 2 the ordering reverses. ElevenLabs produces the exact invoice on 4 of 8 briefs (50%), Intron on 1 (12.5%), and Groq on none, with 7 of 8 Groq briefs blocked. The likely cause is channel robustness: Intron's word error rate rises from 16.4% on the open corpus to 60.6% on the in-house recorded briefs, while ElevenLabs holds at 14.5%. Tone-preserving scoring reveals a further cost hidden by stripped scoring: roughly half of Igbo words scored as correct carry an erroneous or absent tone (56.2% for ElevenLabs, 54.2% for Intron). We conclude that ElevenLabs is the only provider currently suitable for the invoicing path, that Groq is serviceable for English-heavy, high-throughput use, and that Intron deserves a retest once its recorded-brief channel is handled more carefully.

## 1. Introduction

An utterance such as "5 bags of Dangote Cement at 12,500 naira for Adebayo Stores" must be converted into a correct invoice line. Two failure modes are costly in different ways. Mis-transcribed amounts corrupt billing quietly; blocked flows, where the parser cannot extract structure from the transcript, break the interaction openly. Providers differ along three axes that matter to this product: accuracy on tonal languages, robustness to the recording channel, and latency, which the conversational interface cannot ignore.

Because the two failure modes surface at different layers, we report two validity claims separately. Track 1 is a conventional ASR comparison that a third party could reproduce from the committed transcripts. Track 2 is internal product telemetry that by design combines the ASR model with Sautice's parser and catalogue; its numbers carry meaning only within Sautice.

## 2. Related Work

Comparative ASR evaluation for African languages has settled on a few shared conventions. A single corpus with human ground truth and common normalization across providers avoids the provider-versus-provider comparisons that tend to flatter results. Neutral normalization that strips diacritics is known to understate error on tonal languages, which has driven calls for tone-preserving scoring in the African-ASR literature. Public baselines such as OpenWER and the normalizers published for the Whisper family offer a checkable frame of reference. This study follows those conventions and pairs them with an application-level probe that few public benchmarks attempt.

## 3. Materials and Methods

### 3.1 Corpus

The corpus contains 68 recordings. The open set comprises 60 clips per provider: 20 from the AlaminI CommonVoice subset (English, Hausa, Igbo, and Yoruba, train split), 30 from the McGill-NLP NaijaS2ST set (15 Nigerian English and 15 Nigerian-accented English, development split), and 10 from `asr-nigerian-pidgin` (train split). The product set adds 7 human-recorded Sautice briefs and 1 synthetic TTS invoice prompt, used only for the Track 2 outcome. Reference transcripts were frozen in `pilot_manifest.csv` before any provider was scored. Audio is 16 kHz mono PCM throughout. Per-language counts in the open set are 15 Nigerian English, 15 Nigerian-of-Yoruba-accent English (EY), 10 Pidgin, and 5 each of Hausa, Igbo, and Yoruba.

### 3.2 Systems

Three providers were scored: ElevenLabs `scribe_v1`, Groq `whisper-large-v3-turbo`, and the Intron Sahara API. Gemini `gemini-3.8-flash` was configured but unreachable from the development network during the run and is therefore not ranked. All calls used identical audio and the same prompt conventions. Groq returned HTTP 400 for all five Igbo clips; its open-corpus sample is 55 clips rather than 60.

### 3.3 Normalization and Metrics

Word error rate is computed as (S + D + I) / N with N equal to the reference length (S + D + H), using the jiwer library. Character error rate uses the same convention at the character level. Two normalization schemes are reported. `norm` strips diacritics and light punctuation, matching the frozen headline scheme applied identically across providers. `norm_diac` is the same scheme with `preserve_marks=True`, so tone is scored rather than erased. The tone gap is defined as `norm` minus `norm_diac` in percentage points. Macro averages are unweighted over per-language means, following WAXAL/SimbaBench reporting practice. Network word error rate (NWER) is computed on the four recordings that contain digits and are intended to exercise numeric phrases. Real-time factor (RTFx) is inverse of the ratio of processing time to audio duration.

### 3.4 Product Probe (Track 2)

Each provider's transcript on the 8 product briefs was passed through Sautice's live parser and catalogue. Three outcomes were recorded: exact (the parsed amount, quantity, and item match the human reference), off by a small amount, or blocked (the parser produced nothing). Recorded-brief word error rate is reported separately because the 7 human recordings differ from the open corpus in channel and speaking style.

## 4. Results

### 4.1 Open-Corpus ASR Quality

Table 1 summarizes Track 1. Intron leads on word error rate, character error rate, tone-preserving error, and macro average. ElevenLabs matches it closely on word error while being considerably faster. Groq trails on every quality measure.

**Table 1. Track 1 ASR quality, open corpus (n per provider).**

| provider | n | norm WER (95% CI) | median WER | norm CER | diac-p WER | tone gap | NWER (n=4) | macro WER | RTFx | median latency |
|---|---|---|---|---|---|---|---|---|---|---|
| Intron Sahara | 60 | 16.4% (±5.5) | 10.6% | 7.2% | 19.1% | −2.6 | 14.7% | 22.7% | 0.15× | 12.06 s |
| ElevenLabs | 60 | 18.5% (±7.6) | 3.9% | 7.8% | 21.9% | −3.4 | 10.5% | 25.9% | 1.58× | 1.94 s |
| Groq | 55 | 38.2% (±10.9) | 20.0% | 18.8% | 38.7% | −0.5 | 9.0% | 68.9% | 1.46× | 2.16 s |

### 4.2 Tone-Preserving Scores

Table 2 breaks results down by language. English and Pidgin are identical across schemes by construction, since neither is scored with marks. Igbo carries the largest tone gap for both ElevenLabs (−32.9 pp) and Intron (−22.9 pp), and Yoruba a smaller one for all three providers. Groq's Hausa and Yoruba error rates, above 90%, indicate that the model does not meaningfully serve those languages on this channel.

**Table 2. Norm WER to diac-p WER by language, with tone gap in percentage points.**

| language | ElevenLabs | gap | Groq | gap | Intron | gap |
|---|---|---|---|---|---|---|
| English (Nigerian) | 6.2% → 6.2% | 0.0 | 11.1% → 11.1% | 0.0 | 7.4% → 7.4% | 0.0 |
| Hausa | 19.7% → 19.7% | 0.0 | 92.0% → 92.0% | 0.0 | 14.7% → 14.7% | 0.0 |
| Igbo | 23.3% → 56.2% | −32.9 | — (5/5 failed) | — | 31.3% → 54.2% | −22.9 |
| Yoruba | 25.7% → 33.6% | −7.9 | 94.6% → 100.0% | −5.4 | 21.3% → 29.9% | −8.6 |
| Pidgin | 54.8% → 54.8% | 0.0 | 77.9% → 77.9% | 0.0 | 38.9% → 38.9% | 0.0 |

The error mix, expressed as a share of reference words, is substitution-dominated for all three providers. ElevenLabs substitutes 14.2%, deletes 3.9%, and inserts 1.7% of reference words (hit rate 82.0%); Intron 11.2%, 5.4%, and 1.3% (83.5%); Groq 26.6%, 8.0%, and 2.2% (65.4%). This pattern is consistent with the tonal errors in Table 2, which shifted scoring shows as substitutions.

### 4.3 Product Probe (Track 2)

Table 3 reports the end-to-end outcome. ElevenLabs completes 6 of 8 briefs; Intron and Groq complete 1 and 0, respectively, with the remainder blocked. On the recorded-brief subset, ElevenLabs and Groq both degrade less than Intron.

**Table 3. Track 2 product outcome, voice-to-invoice.**

| provider | money (n=8) | exact | off-small | blocked | ready | recorded briefs (n=7) WER → exact |
|---|---|---|---|---|---|---|
| ElevenLabs | 8 | 4 (50%) | 2 | 2 | 6/8 | 14.5% → 3/7 |
| Groq | 8 | 0 (0%) | 0 | 8 | 0/8 | 29.0% → 0/7 |
| Intron | 8 | 1 (12.5%) | 0 | 7 | 1/8 | 60.6% → 1/7 |

## 5. Discussion

**Channel robustness reverses the ranking.** Intron's word error rate rises from 16.4% on the open corpus to 60.6% on the recorded briefs, while ElevenLabs stays at 14.5%. Because the invoicing input is by definition the in-house brief channel, open-corpus word error rate alone is a weak predictor of product behavior for this task, and a leaderboard-style ranking would have selected the wrong provider.

**Tone is a real, provider-specific cost.** When tone is preserved, Igbo error approximately doubles for ElevenLabs (23.3% to 56.2%) and for Intron (31.3% to 54.2%). Stripped-scoring word error rate makes both providers look substantially more accurate than they are on this language. This is material for any consumer-facing Igbo product and for future TTS verification loops, and it matches the caveat widely raised in the African-ASR literature.

**Numeric tokens are not the main barrier; transcript shape is.** NWER on the four numeric clips is 9–15%, yet money outcome is zero for two of three providers. The blocker is transcript shape feeding the parser: punctuation, currency rendering, and dictation-style phrasing, which is an integration-layer problem rather than a raw accuracy problem. This is precisely what the two-track design is intended to surface.

**Latency gates interactivity.** ElevenLabs and Groq return with a median latency near two seconds (RTFx ≈ 1.5×). Intron's median of 12.1 seconds (RTFx 0.15×) makes live dictation interfaces difficult despite its accuracy.

**Groq is effectively English-only on this data.** Its Hausa and Yoruba error rates exceed 90%, and Igbo fails outright. It remains a reasonable low-latency, low-cost English tier, not a multilingual answer.

## 6. Limitations

Per-language sample sizes are small (5 Igbo, Hausa, and Yoruba; 10 Pidgin; 15 of each English accent), so per-language confidence intervals are wide and macro averages are indicative rather than exhaustive. Live-API drift is observable: a fresh cold rerun of ElevenLabs moved its headline word error rate from 17.0% to 18.5% on identical audio, giving single-run figures roughly a percentage point of run-to-run noise. Three run-on reference spellings are flagged for correction in `ref_audit.tsv` and carry roughly two percentage points of effect on Hausa and Igbo cells only. Gemini was unreachable and is not ranked. Track 2 scores conflate ASR with Sautice's parser and catalogue and are product telemetry, not a generalizable benchmark. The corpus is read speech collected for a commerce scenario, not spontaneous conversation.

## 7. Conclusion

ElevenLabs is the only provider tested that is both accurate under frozen scoring and reliable on the actual recording channel; it is the current choice for the invoicing path. Intron offers the best accuracy on open African corpora and is the natural candidate to retest after tighter audio pre-processing and dictation-friendly prompting. Groq should be treated as a fast English tier. The reference-spelling corrections flagged in the audit should be landed, a punctuation-oriented auxiliary metric should be added to prevent scoring from ignoring transcript shape, and a Gemini run should be opened from an unrestricted network to complete the comparison.

## References

1. Gladia. Benchmarking your speech-to-text provider. docs.gladia.io. Single ground-truth corpus, common normalization.
2. J. Kuhn and T. Zimmermann. OpenWER: Word error rate for 52 languages. arXiv:2606.21237. Compound words, diacritic policy, per-language CER flags.
3. WAXAL-NET. arXiv:2606.02375. Macro averaging and African-ASR reporting norms.
4. SimbaBench. arXiv:2609.06918. African speech benchmark and reporting practice.
5. AfriSwitch. arXiv:2607.20688. Multilingual African ASR and diacritics.
6. OpenAI. whisper-normalizer. Frozen preprocessing for WER.
7. FitZK. jiwer. WER/CER definitions.
8. Open ASR Leaderboard. Inverse real-time factor (RTFx) convention.