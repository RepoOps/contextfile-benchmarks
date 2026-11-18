# Uplift scorecard results

One signed result file per run, written by
`node --experimental-strip-types packages/core/src/uplift-cli.ts run ...` and named
`<date>-<harness version>.json`. `/benchmarks` and `/benchmarks.json` show the newest
result whose digest matches its body and whose signature verifies under a stable
published key (`pem-...`), and list every such result as history. A run signed by an
ephemeral dev key stays here unshown. Never edit or delete an earlier file.

Each file holds `digest`, `body`, `signature` and `publicKey`. The body
(`kind: contextfile.benchmark.uplift/v1`) records:

| Field | What it holds |
| --- | --- |
| `harnessVersion`, `ranAt` | Harness version and the time the run finished. |
| `grading` | How answers were graded: `method: pattern_checks` and the label "Graded by pattern checks on the answer text, not by running tests." Required on every result. |
| `set` | Task set id, version, digest and task count. |
| `prompt` | Prompt version and the sha256 of the system prompt both arms share. |
| `server` | The MCP URL and the tools the with arm was offered. |
| `models[]` | Per model: `arms.with` and `arms.without`, each with `metrics` (accuracy, callRate, tokensPerAnswer, misgroundedRate) and `counts`, plus `perArtifact` uplift for artifacts a grounded citation measured. |
| `items[]` | Per task, model and arm: passed, error, tool calls, tokens and each citation with its grounded flag. |
