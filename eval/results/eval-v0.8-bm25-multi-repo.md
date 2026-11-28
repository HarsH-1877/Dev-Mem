# Multi-Repo FTS5/BM25 & Regression Guard Benchmark (v0.8.0)

Evaluated **24 task/regression sessions** across **3 codebases** (zero LLM mocks; real SQLite + FTS5 + BM25 + `retrieveContext` + `checkRegressionRisk`).

| Repository | Nodes | Pos/Neg Sessions | Baseline Hit@1 | Hybrid Hit@1 | Recall@3 | Baseline MRR | Hybrid MRR | Noise Leakage | Hub Warning Suppressed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `dev-mem-cli` | 8 | 7/1 | 85.7% | 85.7% | 85.7% | 0.857 | 0.857 | 0/1 | 1/1 |
| `ts-saas-api` | 14 | 7/1 | 85.7% | 100.0% | 100.0% | 0.857 | 1.000 | 0/1 | 1/1 |
| `fullstack-monorepo` | 14 | 7/1 | 100.0% | 100.0% | 100.0% | 1.000 | 1.000 | 0/1 | 1/1 |

## Aggregate Results
- **Hybrid Hit@1:** 95.2% (Jaccard baseline: 90.5%)
- **Hybrid Recall@3:** 95.2%
- **Mean Reciprocal Rank (MRR):** 0.952 (Jaccard baseline: 0.905)
- **Negative Query Leakage:** 0.0%
- **Hub-File False-Positive Regression Suppression:** 100.0%
