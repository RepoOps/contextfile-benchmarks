# ContextFile benchmarks

The data and harness code behind https://contextfile.ai/benchmarks. Use it to check
every published result offline, with no key, and to rerun a benchmark with your own
OpenRouter key.

Three benchmarks live here:

- **Golden set** (`benchmarks/golden-set/`, results in `benchmarks/results/`): how well
  ContextFile's verifier judge scores claims against their cited passages. It reports
  precision, recall, the misgrounded-citation rate and the false-claim pass rate. The
  set is a pilot: 30 works of a planned 220.
- **Uplift scorecard** (`benchmarks/uplift/`): the same model on version-pinned coding
  tasks, with and without the ContextFile MCP server. No result is published yet.
- **Tool selection evals** (`benchmarks/tool-selection/`): how often a model calls
  ContextFile when it should, and does not when it should not, with other docs servers
  installed beside it; and whether it calls `context_load` at the start of a session.

Each folder has its own README with the method. This repository is generated from the
private ContextFile monorepo at commit `d14d3b325714b0e4821f4dd47984af7e44db8105` by `scripts/publish-benchmarks.mjs`;
`source.json` maps every file here to the monorepo file it came from. Do not send pull
requests that edit the copied files: report a problem in an issue and the fix lands in
the monorepo, then here.

## Requirements

Node 22.6 or later (the code runs as TypeScript through `--experimental-strip-types`),
and npm. The one dependency is zod.

```
git clone https://github.com/RepoOps/contextfile-benchmarks
cd contextfile-benchmarks
npm ci
```

## Verify the published results (offline, no key)

```
npm run verify
```

This checks, with no network and no model call:

- every golden-set work matches its digest in the manifest, and the set digest matches;
- `benchmarks/judge-prompt.json` is the judge prompt in `packages/core/src/judge.ts`,
  byte for byte, and its sha256 is the hash results pin;
- every signed result (golden set and uplift) has a digest equal to the sha256 of its
  canonical body, a signature that verifies under the public key in the file, and a key
  id equal to the hash of that key;
- the judge gate passes: the live judge has a signed result that meets the thresholds
  in `config/constants.md`;
- every tool selection and session-start result has a digest that matches its body,
  and metrics that follow from its recorded outcomes.

It exits 1 and names each failure. The same checks run one at a time:

```
npm run golden -- check
npm run golden -- manifest
npm run golden -- judge-prompt
npm run golden -- gate
npm run uplift -- check
npm run selection -- check
npm run session-start -- check
```

A valid signature proves the file was not changed after it was signed. To know that
ContextFile signed it, compare the file's `signature.keyId` with the published key set
at https://contextfile.ai/.well-known/report-keys. A key listed as `retired` still
counts for results signed while it was active (`valid_from` to `valid_to`).

## Rerun the golden set with your own key

The judge runs through OpenRouter on your key, at temperature 0. One full run makes one
model call per claim (180 claims in the pilot set), billed to your OpenRouter account.

```
OPENROUTER_API_KEY=<your key> npm run golden -- run --backend openrouter --model <model id> --out my-run.json
npm run golden -- compare benchmarks/results/<published file>.json my-run.json
```

Use the model id of the published file you compare against (its `body.judge.model`).
`compare` passes when the set digest, judge prompt hash and judge model match and each
metric is within the published tolerance (`golden_rerun_tolerance`, an Example value
until reruns measure it). Your result is signed by a throwaway key unless you set
`REPORT_SIGNING_KEY_PEM`; that does not matter for `compare`. `--limit <n>` scores only
the first n claims, and a partial run is not comparable to a full one.

## Rerun the tool selection evals

```
OPENROUTER_API_KEY=<your key> npm run selection -- run --model <model id> --out my-selection.json
OPENROUTER_API_KEY=<your key> npm run session-start -- run --model <model id> --out my-session.json
```

One model call per task. The model sees ContextFile's tools from
`packages/mcp/src/tools.ts`, a snapshot of the monorepo's tool list at the commit this
tree came from. A published result does not record a digest of the tool list, so a
rerun today can see different tools than the published run did.

## Rerun the uplift scorecard

The with arm calls the live ContextFile MCP server at https://mcp.contextfile.ai/mcp,
so besides `OPENROUTER_API_KEY` it needs `CONTEXTFILE_UPLIFT_TOKEN`, a ContextFile agent
token (a sandbox token from `cf login` works). See `benchmarks/uplift/README.md`.

## What differs from the monorepo

The harness files are copied as they are, with their imports pointed inside this tree.
These files are not straight copies:

| File | What it is |
| --- | --- |
| `packages/mcp/src/tools.ts` | A snapshot of the MCP tool list: names, descriptions, input schemas, and the former tool names still accepted. Generated. |
| `packages/core/src/openrouter.ts` | The OpenRouter client without the paths for a customer's own model key. It sends the same request as the monorepo client. |
| `packages/core/src/constants.ts` | Reads `config/constants.md`, which holds only the thresholds and tolerances the harness uses. |
| `packages/core/src/types/registry.ts`, `packages/mcp/src/instruction-block.ts` | The artifact type names and the `cf install` instructions block, as constants. Generated. |

The generator's check (run in the monorepo before every publish) runs `npm run verify`
in a fresh copy of this tree and compares these files' behavior with the monorepo code.

## License

The harness code is Apache-2.0 (`LICENSE`). The data files carry their own license
fields; `NOTICE` lists them, including the GitChameleon 2.0 tasks under MIT.
