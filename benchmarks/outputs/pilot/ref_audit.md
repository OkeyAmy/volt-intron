# Reference audit — `pilot`

Consensus classifier: when providers agree with each other (median pairwise WER ≤ 0.15) but all disagree with the reference (median ref WER ≥ 0.40), the reference/audio pair is a mismatch candidate — flags never overrule human review.
- total cells: 68
- flagged: 28
- REF_MISMATCH_CANDIDATE: 1

| id | source | pair WER | ref WER | reference |
|---|---|---|---|---|
| alamin_igbo_3028 | alamin-cv | 0.0 | 0.5 | maazị Abang |

Full per-cell flags: `ref_audit.tsv`.
