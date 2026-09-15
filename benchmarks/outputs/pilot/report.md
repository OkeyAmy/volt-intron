# Sautice STT Benchmark — `pilot`

Generated: 2026-09-15

Two tracks, distinct validity claims:
- **Track 1 — ASR quality (industry-standard metrics).** WER/CER via `jiwer` with frozen whisper-normalizer preprocessing over open, human-transcribed corpora (Nigerian Common Voice subset, NaijaS2ST, Nigerian pidgin), stratified by accent/language. Comparable to OpenASR/MLPerf-style reporting.
- **Track 2 — Sautice product probe (NOT a benchmark).** End-to-end voice→invoice accuracy of the Sautice stack (ASR + Sautice heuristic parser). Scores conflate both systems and are not comparable outside Sautice; reported for downstream-provider decisions only.

## Track 1 — ASR quality (standard)
| provider | n (corpus) | norm WER (95% CI) | norm CER | basic WER | latency | cost est. (cr) |
|---|---|---|---|---|---|---|
| intron_sahara | 60 | 16.4% (±5.5) | 7.2% | 17.3% | 19.5s | 84.3 |

### Track 1 — accent / language / source breakdown (norm WER)
**intron_sahara**
- accent: EN 9.1% (n=15) · EY 6.0% (n=15) · nigerian-cv 18.5% (n=20) · pidgin 38.9% (n=10)
- language: english 7.4% (n=35) · hausa 14.7% (n=5) · igbo 31.3% (n=5) · pidgin 38.9% (n=10) · yoruba 21.2% (n=5)
- source: alamin-cv 18.5% (n=20) · naija-s2st 7.6% (n=30) · nigerian-pidgin 38.9% (n=10)

## Track 2 — Sautice product probe (ASR + Sautice parser; separate validity)
| provider | n | exact | off≤10% | catastrophic>10% | blocked | exact rate |
|---|---|---|---|---|---|---|
| intron_sahara recorded briefs | 7 | 1 | 0 | 0 | 6 | 14.3% |
| intron_sahara synthetic TTS (deprecated) | 1 | 0 | 0 | 0 | 1 | 0.0% |

Supplementary: recorded briefs paired corpus WER = 60.6% (n=7) 

Notes: Track 2 blocked rows are cases the parser could not resolve (ASR hallucination or normalization gap in Sautice customer matching). Recorded rows are live human recordings of the SautiBench money briefs; synthetic rows are Intron-TTS clips retained as an auxiliary signal.
