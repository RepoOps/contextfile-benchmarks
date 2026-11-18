# Golden-set results

One signed result file per run, written by
`node --experimental-strip-types packages/core/src/golden-cli.ts run ...`. The
`/benchmarks` page and `/benchmarks.json` show the newest result whose digest matches
its body and whose signature verifies under a stable published key (`pem-...`). A run
signed by an ephemeral dev key stays here unshown.

Each file holds `digest`, `body`, `signature` and `publicKey`. The body records the
judge model, judge prompt version and hash, harness version, set digest, run time,
pass threshold, rerun tolerance, the metrics, the counts and every per-claim score.
