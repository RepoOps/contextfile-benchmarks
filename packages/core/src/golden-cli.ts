// The golden-set harness CLI (R6). Run from the repo root:
//
//   node --experimental-strip-types packages/core/src/golden-cli.ts <command> [options]
//
//   manifest [--write]   rebuild benchmarks/golden-set/manifest.json from the work files
//                        (without --write: fail when the committed manifest is stale)
//   check                validate the set; print claims per verdict and labeler agreement
//   run                  judge every claim and write a signed result file
//       --backend openrouter --model <id>      the judge through OpenRouter (needs OPENROUTER_API_KEY;
//                                              an outside rerun uses the runner's own key)
//       [--out <file>] [--limit <n>] [--concurrency <n>]
//   compare <published.json> <rerun.json>   does a rerun match within the published tolerance
//   gate                 the judge change gate CI runs (exit 1 names the metric that fell)
//   judge-prompt [--write]  rebuild benchmarks/judge-prompt.json from judge.ts
//                        (without --write: fail when the committed file is stale)
//
// Signing: `run` signs with REPORT_SIGNING_KEY_PEM. Without it the result is signed by
// an ephemeral dev key and the /benchmarks page will not publish it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  benchmarksRoot,
  buildManifest,
  buildResultBody,
  compareRuns,
  goldenConfig,
  goldenItems,
  interLabelerAgreement,
  judgeGate,
  judgeItem,
  loadGoldenSet,
  loadJudgeGatePin,
  loadResults,
  readWorkTexts,
  SignedGoldenResultSchema,
  signResult,
  type GoldenItem,
  type GoldenJudgement,
  type GoldenResultBody,
} from "./golden-set.ts";
import { buildJudgeMessages, JUDGE_PROMPT_FILE, JUDGE_PROMPT_VERSION, judgePromptFileText, judgePromptHash } from "./judge.ts";
import { chat, OpenRouterError, parseJson } from "./openrouter.ts";
import { LocalDevSigner } from "./signing.ts";

const SET_ID = "contextfile-golden";
const SET_VERSION = "0.1.0";
const TARGET_WORKS = 220;
/** The 30 works are published as a pilot until the set reaches TARGET_WORKS (owner decision 2026-11-11). */
const SET_STAGE = "pilot" as const;

/** A judge backend scores one claim against one passage. Null entailment = the call failed. */
export interface JudgeBackend {
  pin(): Promise<GoldenResultBody["judge"]>;
  score(item: GoldenItem): Promise<number | null>;
}

const clamp = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
};

/** The judge prompt called through OpenRouter at temperature 0, with the runner's own key. */
export function openRouterBackend(model: string, chatImpl: typeof chat = chat): JudgeBackend {
  return {
    async pin() {
      return { model, promptVersion: JUDGE_PROMPT_VERSION, promptHash: judgePromptHash(), backend: "openrouter" };
    },
    async score(item) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await chatImpl({ model, temperature: 0, json: true, messages: buildJudgeMessages(item.claim, item.passage) });
          return clamp(parseJson<{ entailment?: unknown }>(r.text).entailment);
        } catch (e) {
          if (!(e instanceof OpenRouterError && e.retryable) || attempt === 2) return null;
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        }
      }
      return null;
    },
  };
}

/** Judge every item with bounded concurrency, in set order. */
export async function runHarness(items: GoldenItem[], backend: JudgeBackend, passThreshold: number, concurrency = 4): Promise<GoldenJudgement[]> {
  const out: GoldenJudgement[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      out[i] = judgeItem(item, await backend.score(item), passThreshold);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

export async function runGoldenCli(argv: readonly string[]): Promise<string> {
  const [command, ...rest] = argv;
  const root = benchmarksRoot();
  switch (command) {
    case "manifest": {
      const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" } }, strict: true });
      const manifest = buildManifest(readWorkTexts(root), { id: SET_ID, version: SET_VERSION, targetWorks: TARGET_WORKS, stage: SET_STAGE });
      const file = join(root, "golden-set", "manifest.json");
      const text = stableJson(manifest);
      if (values.write) {
        writeFileSync(file, text);
        return `[golden] wrote manifest: ${manifest.works.length} works, set digest ${manifest.setDigest}`;
      }
      let current = "";
      try {
        current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      } catch {
        /* missing manifest is stale */
      }
      if (current !== text) throw new Error("[golden] manifest.json is stale; run: golden-cli.ts manifest --write");
      return `[golden] manifest is current: ${manifest.works.length} works`;
    }
    case "judge-prompt": {
      const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" } }, strict: true });
      const file = join(root, JUDGE_PROMPT_FILE);
      const text = judgePromptFileText();
      if (values.write) {
        writeFileSync(file, text);
        return `[golden] wrote ${JUDGE_PROMPT_FILE}: judge ${JUDGE_PROMPT_VERSION} ${judgePromptHash()}`;
      }
      let current = "";
      try {
        current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      } catch {
        /* missing file is stale */
      }
      if (current !== text) throw new Error(`[golden] ${JUDGE_PROMPT_FILE} is stale; run: golden-cli.ts judge-prompt --write`);
      return `[golden] ${JUDGE_PROMPT_FILE} is current: judge ${JUDGE_PROMPT_VERSION}`;
    }
    case "check": {
      const set = loadGoldenSet(root);
      const items = goldenItems(set);
      const by = (k: string) => items.filter((i) => i.expected === k).length;
      const ag = interLabelerAgreement(set.works);
      return [
        `[golden] set ${set.manifest.id} ${set.manifest.version}, digest ${set.manifest.setDigest}`,
        `[golden] ${set.manifest.stage} set: works ${set.works.length} of ${set.manifest.targetWorks}; claims ${items.length} (supported ${by("supported")}, wrong ${by("wrong")}, misgrounded ${by("misgrounded")})`,
        `[golden] double-labeled claims ${ag.doubleLabeled}; observed agreement ${ag.observed ?? "n/a"}; kappa ${ag.kappa ?? "n/a"}`,
      ].join("\n");
    }
    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: { backend: { type: "string" }, model: { type: "string" }, out: { type: "string" }, limit: { type: "string" }, concurrency: { type: "string" } },
        strict: true,
      });
      if (values.backend !== "openrouter" || !values.model) throw new Error("[golden] usage: run --backend openrouter --model <id>");
      const backend: JudgeBackend = openRouterBackend(values.model);
      const config = goldenConfig();
      const set = loadGoldenSet(root);
      let items = goldenItems(set);
      if (values.limit) items = items.slice(0, Number(values.limit));
      const judgements = await runHarness(items, backend, config.passThreshold, values.concurrency ? Number(values.concurrency) : 4);
      const body = buildResultBody({ set, judge: await backend.pin(), judgements, passThreshold: config.passThreshold, tolerance: config.rerunTolerance });
      const signer = new LocalDevSigner(process.env.REPORT_SIGNING_KEY_PEM);
      const signed = signResult(body, signer);
      const slug = body.judge.model.replace(/[^a-z0-9.]+/gi, "-").toLowerCase();
      const out = values.out ?? join(root, "results", `${body.ranAt.slice(0, 10)}-${body.judge.promptVersion}-${slug}.json`);
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, stableJson(signed));
      const m = body.metrics;
      return `[golden] ${items.length} claims, ${body.counts.errors} judge errors; precision ${m.precision} recall ${m.recall} misgrounded ${m.misgroundedRate}; wrote ${out}${values.limit ? " (partial run: not comparable to a full result)" : ""}`;
    }
    case "compare": {
      const [a, b] = rest;
      if (!a || !b) throw new Error("[golden] usage: compare <published.json> <rerun.json>");
      const pub = SignedGoldenResultSchema.parse(JSON.parse(readFileSync(a, "utf8")));
      const re = SignedGoldenResultSchema.parse(JSON.parse(readFileSync(b, "utf8")));
      const c = compareRuns(pub.body, re.body);
      const lines = c.diffs.map((d) => `  ${d.metric}: published ${d.published} rerun ${d.rerun} diff ${d.diff ?? "n/a"} ${d.ok ? "ok" : "OUT OF TOLERANCE"}`);
      if (!c.match) throw new Error(`[golden] rerun does not match (tolerance ${c.tolerance}):\n${lines.join("\n")}\n  ${c.problems.join("\n  ")}`);
      return `[golden] rerun matches within ${c.tolerance}:\n${lines.join("\n")}`;
    }
    case "gate": {
      const outcome = judgeGate({
        live: { version: JUDGE_PROMPT_VERSION, hash: judgePromptHash() },
        pin: loadJudgeGatePin(root),
        results: loadResults(root).results,
        config: goldenConfig(),
      });
      if (!outcome.ok) throw new Error(`[golden] judge gate FAILED: ${outcome.reason}`);
      return `[golden] judge gate ok: ${outcome.reason}`;
    }
    default:
      throw new Error("[golden] commands: manifest [--write] | check | run | compare <a> <b> | gate");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runGoldenCli(process.argv.slice(2)).then(
    (msg) => {
      process.stdout.write(msg + "\n");
    },
    (e: unknown) => {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
      process.exit(1);
    }
  );
}
