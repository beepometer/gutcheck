# evidence pipeline

Mines real AI-authored, test-touching commits from GitHub as evidence (never synthetic/generated cases).

Run order: `harvest-trailers.mjs` (searches trailer queries, funnels candidates via `judge()`) →
`drive.mjs` (clone + pre/post test run, later task) → `archaeology.mjs` (diff inspection, later task) →
`aggregate.mjs` (rolls funnel + drive + archaeology into a summary, later task).

`results/work.jsonl` (git-ignored): `{ id, source, query, repo, sha, parent_expr, clone_url, size_kb, test_files[] }`
— one accepted candidate per line.
`results/funnel.jsonl` (git-ignored): `{ query, candidate, excluded }` — one row per rejected candidate,
so the funnel is total.

`lib.mjs` — shared, zero-dependency helpers (`isTestFile`, `appendJsonl`, `readJsonl`, `sh`).
