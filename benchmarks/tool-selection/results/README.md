# Tool selection results

One file per run, written by
`node --experimental-strip-types packages/mcp/src/selection-eval-cli.ts run --model <id>`.
Each file holds `digest` (sha256 of the canonical body) and `body`: model, run time,
harness version, the digests of `tasks.json` and `competitors.json`, the competing
servers, skipped match tasks, the metrics and every outcome. `/benchmarks` shows the
newest result per model whose digest matches its body.

The first runs (2026-11-11) cover a Claude, a GPT and a Gemini model. Match tasks wait until
the catalog holds their artifacts, so those runs score control and purchase tasks only.
