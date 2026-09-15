# Sautice STT Provider Evaluation: A Product-Centric Analysis of Three ASR Providers Across Five Nigerian Languages

**Research Report** · Sautice Engineering · Snapshot: `benchmarks/outputs/pilot` · Metrics version `2.0`

---

## Abstract

Sautice's core loop converts spoken voice into structured invoices. Choosing the wrong speech-to-text (STT) provider is therefore a direct revenue-hygiene decision, not an engineering detail. This report compares three ASR providers — **ElevenLabs Speech-to-Text (`scribe_v1`)**, **Groq (`whisper-large-v3-turbo`)**, and **Intron Sahara (API)** — on a fixed corpus of 68 recorded clips spanning **English (Nigerian), Pidgin, Hausa, Igbo, and Yoruba**, using a frozen, industry-standard scoring protocol. On the open-corpus Track 1 benchmark, Intron leads at **16.4% WER** (CER 7.2%) and ElevenLabs follows at **18.5%** (CER 7.8%); Groq trails at **38.2%** with near-total failure on Hausa and Yoruba. Under the product-centric Track 2 voice→invoice probe, the ranking **inverts**: ElevenLabs produces the exact invoice on **50%** of scenario briefs, Groq on **0%** (7/7 blocked), and Intron on **12.5%** — driven by Intron's degradation on in-house recorded briefs (60.6% WER) and Groq's transcription failures. **Recommendation: ElevenLabs is the only provider that is both accurate and product-ready today; Groq is usable for English-only, low-latency volume; Intron requires stricter audio normalization before it can be trusted in the money path.**

**Industry alignment.** Protocol follows the Gladia benchmarking guide (single ground-truth dataset, identical normalization across providers, never provider-vs-provider); WER = (S+D+I)/N via `jiwer` with frozen `whisper-normalizer` preprocessing; tone-preserving `diac-p` companion and unweighted macro averages follow 2026 African-ASR practice (OpenWER, WAXAL-NET, SimbaBench); every number is re-derivable from committed raw transcripts.

---

## 1. Motivation

Sautice's product takes a spoken instruction such as *"5 bags of Dangote Cement at 12,500 naira for Adebayo Stores"* and must emit a correct invoice line. Two failure shapes are expensive: **mis-transcribed numbers** (NWER) and **blocked flows** where the engine cannot parse the transcript at all. Both are provider-dependent because each ASR family differs in (a) tonal-language accuracy (Hausa/Igbo/Yoruba carry meaning in tone that stripped normalization hides), (b) channel robustness on our in-house briefs, and (c) latency, which gates the conversational product. This study therefore reports *two* deliberately separate validity claims: Track 1 mirrors open-ASR leaderboards; Track 2 is an end-to-end Sautice probe that *intentionally* conflates ASR + Sautice parser and is "not comparable outside Sautice".

## 2. Industry-standard protocol (checked)

| Gladia benchmarking requirement | This study |
|---|---|
| One dataset, human ground truth | 68 clips, references frozen in `pilot_manifest.csv` *before* scoring |
| Same normalization for all providers | Frozen whisper-normalizer scheme applied to identical raw transcripts |
| No provider-vs-provider scoring | Each hypothesis normalized against the human reference only |
| Production-like audio | Nigerian-accented open corpora + in-house recorded briefs |
| Reproducible evidence | All raw hypotheses committed; per-cell consistency assert `WER==(S+D+I)/N` |

Scoring: **WER = (S+D+I)/N**, N = reference length (S+D+H), via `jiwer`; CER likewise. Normalization schemes: `norm` (EnglishTextNormalizer for English, BasicTextNormalizer with diacritic-stripping otherwise — the frozen headline), `norm_diac` (same but `preserve_marks=True`, so tone is scored instead of erased; **tone gap = norm − diac-p**), `basic` (light clean). Macro averages are unweighted over per-language means (WAXAL/SimbaBench convention). Cost is pinned (est. ≤108 Intron credits; balance shown in `cost.json`).

## 3. Corpus and setup

- **60 open-corpus cells/provier**: 20 AlaminI CommonVoice clips (en/ha/ig/yo, train), 30 McGill-NLP NaijaS2ST clips (EN×15, EY×15, dev), 10 `asr-nigerian-pidgin` clips (train).
- **+8 product cells**: 7 human-recorded Sautice briefs (`source=recorded`) and 1 TTS synthetic invoice prompt, scored on Track 2 money outcome.
- Providers: ElevenLabs `scribe_v1`, Groq `whisper-large-v3-turbo`, Intron Sahara API. Gemini `gemini-3.8-flash` configured but network-blocked (documented in README). Audio: 16 kHz mono PCM. 204 scored cells; groq Igbo **5/5 cells failed HTTP 400** → groq corpus n=55.

## 4. Results

**Table 1 — Track 1 ASR quality (open corpus).**

| provider | n | norm WER (95% CI) | median WER | norm CER | WER diac-p | tone gap | NWER (n=4) | macro WER | RTFx | median latency |
|---|---|---|---|---|---|---|---|---|---|---|
| Intron Sahara | 60 | **16.4%** (±5.5) | 10.6% | **7.2%** | **19.1%** | −2.6 | 14.7% | **22.7%** | 0.15× | **12.06 s** |
| ElevenLabs | 60 | 18.5% (±7.6) | 3.9% | 7.8% | 21.9% | −3.4 | 10.5% | 25.9% | **1.58×** | 1.94 s |
| Groq | 55 | 38.2% (±10.9) | 20.0% | 18.8% | 38.7% | −0.5 | **9.0%** | 68.9% | 1.46× | 2.16 s |

**Table 2 — per-language norm WER → WER diac-p (tone gap in pp).** English identical across schemes by construction.

| language | ElevenLabs | gap | Groq | gap | Intron | gap |
|---|---|---|---|---|---|---|
| English (Nigerian) | 6.2% → 6.2% | 0.0 | 11.1% → 11.1% | 0.0 | 7.4% → 7.4% | 0.0 |
| Hausa | 19.7% → 19.7% | 0.0 | 92.0% → 92.0% | 0.0 | 14.7% → 14.7% | 0.0 |
| Igbo | 23.3% → **56.2%** | **−32.9** | — (5/5 failed) | — | 31.3% → **54.2%** | **−22.9** |
| Yoruba | 25.7% → 33.6% | −7.9 | 94.6% → 100% | −5.4 | 21.3% → 29.9% | −8.6 |
| Pidgin | 54.8% → 54.8% | 0.0 | 77.9% → 77.9% | 0.0 | 38.9% → 38.9% | 0.0 |

Error mix (share of reference words): ElevenLabs subs 14.2% / dels 3.9% / ins 1.7% (hits 82.0%); Intron 11.2% / 5.4% / 1.3% (83.5%); Groq 26.6% / 8.0% / 2.2% (65.4%) — **substitution-dominated**, consistent with the tonal-error signal below.

**Table 3 — Track 2 product probe (voice → invoice).**

| provider | money (n=8) | exact | off-small | blocked | ready | recorded briefs (n=7) WER → exact |
|---|---|---|---|---|---|---|
| ElevenLabs | 8 | **4 (50%)** | 2 | 2 | 6/8 | 14.5% → 3/7 exact |
| Groq | 8 | 0 (0%) | 0 | **8** | 0/8 | 29.0% → 0/7 |
| Intron | 8 | 1 (12.5%) | 0 | 7 | 1/8 | **60.6%** → 1/7 |

## 5. Analysis — what this means for Sautice

1. **Ranking inverts between tracks.** Intron wins open-corpus WER but fails the product probe; ElevenLabs wins the product probe. The cause is **channel robustness**: on our recorded briefs, Intron's WER jumps 16.4% → **60.6%** while ElevenLabs stays at 14.5%. For Sautice, whose input *is* the in-house brief channel, open-corpus WER alone is a misleading vendor signal.
2. **Tone is a real, provider-specific cost.** Igbo diac-p explodes to 56.2% (ElevenLabs) and 54.2% (Intron) — i.e. ~half of "correct" Igbo words carry wrong/missing tone once preserved. This is invisible in stripped-normalizer WER and matches OpenWER/FER guidance that tone erasure flatters ASR. It is *material* for any consumer-facing Igbo product and for future TTS-verification loops.
3. **Numbers are not the bottleneck on the corpus but cash is anyway:** NWER is 9–15% on the 4 numeric clips yet money-outcome is 0% for 2/3 providers — the blocker is transcript *shape* (punctuation, currency symbols, dictation-style phrasing) feeding the parser, i.e. a Sautice-engine integration layer, not raw ASR accuracy. This is precisely what the two-track design is meant to surface.
4. **Latency gates interactivity.** ElevenLabs/Groq return ~2 s median (RTFx ≈1.5×); Intron median **12.1 s** (RTFx 0.15×) makes it hard for live dictation UIs despite best accuracy.
5. **Groq is effectively English/Pidgin-only on this data** (Hausa 92%, Yoruba 95%, Igbo 100% failure) — acceptable as a cheap high-throughput English tier, not a multilingual answer.

## 6. Cross-validation against OpenWER (2026)

We audited the reference implementation of OpenWER (arXiv 2606.21237) against our pipeline on the same 199 scored cells. Verdicts: (i) OpenWER's WER denominator is reference length **N = OK+SUB+DEL**, identical to our `n_ref` fix; (ii) default OpenWER strips diacritics and excludes punctuation — equivalent to our `norm`; (iii) its compound-word detection improves WER by ~0–2 pp on our corpus, and the largest deltas are run-on *reference* spellings (e.g. `Meyasa` vs `Me ya sa`, `ugbua` vs `ugbu a`) — a known reference-hygiene item flagged in `ref_audit.tsv`, not a scoring defect; (iv) OpenWER *cannot* score Igbo or Pidgin (language table raises `ValueError`), so our coverage exceeds the state-of-the-art reference. **No core scoring defect was found; methodology stands.**

## 7. Threats to validity

- **n per language is small** (5 Igbo/Hausa/Yoruba; 10 Pidgin; 15 EY/EN) — per-language CIs are wide; macro averages are indicative, not exhaustive.
- **Live-API drift:** ElevenLabs headline moved 17.0% → 18.5% on a fresh cold rerun (non-deterministic API changes under identical audio); single-run numbers carry ±~1 pp run-to-run noise.
- **Reference hygiene:** 3 run-on reference spellings flagged for correction (pending); their effect is ~±2 pp on Hausa/Igbo cells only.
- **Gemini blocked** on the development network; not included in rankings.
- Track 2 scores conflate ASR with Sautice's parser/catalogue; they are product telemetry, not a generalizable benchmark.

## 8. Conclusion

For the Sautice money path, **ElevenLabs is the defensible default**: best product-probe outcome (50% exact, 6/8 ready), 7.8% CER, ~2 s latency, robust to the recorded-brief channel. **Intron is the accuracy champion for open African corpora** (16.4% WER, best macro 22.7%) and is the candidate to re-test after tighter audio pre-processing and dictation-friendly system prompts. **Groq serves as the cost-speed English/Pidgin tier.** Next steps: land the reference-spelling refactor, add OpenWER's punctuation auxiliary, and re-open a controlled Gemini run from an unrestricted network.

---

### References
- Gladia, *Benchmarking your speech-to-text provider* — docs.gladia.io (single ground-truth corpus, common normalization).
- J. Kuhn & T. Zimmermann, *OpenWER: Word Error Rate for 52 Languages*, arXiv:2606.21237 (compound words, diacritic policy, per-language CER flags).
- WAXAL-NET, arXiv:2606.02375; SimbaBench, arXiv:2609.06918; AfriSwitch, arXiv:2607.20688 (macro averaging, African-ASR reporting norms).
- OpenAI, *whisper-normalizer*; FitZK/jiwer (WER/CER definitions, frozen preprocessing).
- Open ASR Leaderboard, inverse real-time factor (RTFx) convention.