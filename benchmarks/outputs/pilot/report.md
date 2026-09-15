# Sautice STT Benchmark — `pilot`

Generated: 2026-09-15

Two tracks, distinct validity claims:
- **Track 1 — ASR quality (industry-standard metrics).** WER/CER via `jiwer` with frozen whisper-normalizer preprocessing over open, human-transcribed corpora (Nigerian Common Voice subset, NaijaS2ST, Nigerian pidgin), stratified by accent/language. Comparable to OpenASR/MLPerf-style reporting.
- **Track 2 — Sautice product probe (NOT a benchmark).** End-to-end voice→invoice accuracy of the Sautice stack (ASR + Sautice heuristic parser). Scores conflate both systems and are not comparable outside Sautice; reported for downstream-provider decisions only.

## Track 1 — ASR quality (standard)
| provider | n (corpus) | norm WER (95% CI) | norm CER | basic WER | latency | cost est. (cr) |
|---|---|---|---|---|---|---|
| elevenlabs | 60 | 17.0% (±7.3) | 6.7% | 17.1% | 3.2s | 84.3 |
| groq_whisper | 60 | 38.2% (±10.9) | 18.8% | 38.0% | 2.5s | 84.3 |

### Track 1 — accent / language / source breakdown (norm WER)
**elevenlabs**
- accent: EN 5.6% (n=15) · EY 7.8% (n=15) · nigerian-cv 16.1% (n=20) · pidgin 49.5% (n=10)
- language: english 6.2% (n=35) · hausa 24.7% (n=5) · igbo 23.3% (n=5) · pidgin 49.5% (n=10) · yoruba 13.0% (n=5)
- source: alamin-cv 16.1% (n=20) · naija-s2st 6.7% (n=30) · nigerian-pidgin 49.5% (n=10)

**groq_whisper**
- accent: EN 12.1% (n=15) · EY 9.1% (n=15) · nigerian-cv 75.2% (n=20) · pidgin 77.9% (n=10)
- language: english 11.1% (n=35) · hausa 92.0% (n=5) · igbo 100.0% (n=5) · pidgin 77.9% (n=10) · yoruba 94.6% (n=5)
- source: alamin-cv 75.2% (n=20) · naija-s2st 10.6% (n=30) · nigerian-pidgin 77.9% (n=10)

## Track 2 — Sautice product probe (ASR + Sautice parser; separate validity)
| provider | n | exact | off≤10% | catastrophic>10% | blocked | exact rate |
|---|---|---|---|---|---|---|
| elevenlabs recorded briefs | 7 | 3 | 2 | 0 | 2 | 42.9% |
| groq_whisper recorded briefs | 7 | 0 | 0 | 0 | 7 | 0.0% |
| elevenlabs synthetic TTS (deprecated) | 1 | 1 | 0 | 0 | 0 | 100.0% |
| groq_whisper synthetic TTS (deprecated) | 1 | 0 | 0 | 0 | 1 | 0.0% |

Supplementary: recorded briefs paired corpus WER = 29.0% (n=7) 

Notes: Track 2 blocked rows are cases the parser could not resolve (ASR hallucination or normalization gap in Sautice customer matching). Recorded rows are live human recordings of the SautiBench money briefs; synthetic rows are Intron-TTS clips retained as an auxiliary signal.
