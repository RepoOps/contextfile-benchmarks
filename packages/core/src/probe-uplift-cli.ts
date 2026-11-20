// The per-listing uplift test CLI (roadmap item 5). Run from the repo root:
//
//   node --experimental-strip-types packages/core/src/probe-uplift-cli.ts <command> [options]
//
//   check                validate every probe set and the run config; print each set's digest
//   estimate [--listing <seed id>]... [--models <n>] [--artifact-tokens <n>] [--summary-tokens <n>]
//            [--price-in <usd per million>] [--price-out <usd per million>]
//                        print the calls, tokens and upper-bound cost of a run. No model call.
//   run --listing <seed id> --artifact <file> --summary <file> --summary-model <id> --summary-source <url>
//       --artifact-id <uuid> --artifact-version <n> [--listing-id <uuid>] [--report-digest <d>]
//       [--model <id>]... [--out <file>]
//                        run the three arms for each model and write one signed result.
//                        BILLABLE: every call goes to OpenRouter. Needs OPENROUTER_API_KEY.
//
// Signing: `run` signs with REPORT_SIGNING_KEY_PEM. Without it the result is signed by an
// ephemeral dev key and the listing page will not show it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildProbeResultBody,
  estimateProbeRun,
  loadProbeRunConfig,
  loadProbeSets,
  probeRoot,
  probeSetDigest,
  probeUserMessage,
  roughTokens,
  scoreProbe,
  signProbeResult,
  PROBE_ARMS,
  PROBE_SYSTEM_PROMPT,
  type ProbeArm,
  type ProbeCompletion,
  type ProbeItem,
  type ProbeResultBody,
  type ProbeSet,
} from "./probe-uplift.ts";
import { LocalDevSigner } from "./signing.ts";
import { harnessModelKey } from "./uplift-cli.ts";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

type Fetch = typeof fetch;

/** One model call. Tests pass a stub; the run passes OpenRouter. */
export interface ProbeModelClient {
  complete(req: { model: string; system: string; user: string; temperature: number; maxTokens: number; seed: number }): Promise<ProbeCompletion>;
}

/** OpenRouter chat completions, no tools, with the provider's billed cost when it reports one. */
export function openRouterProbeClient(apiKey: string, fetchImpl: Fetch = fetch): ProbeModelClient {
  return {
    async complete(req) {
      const res = await fetchImpl(OPENROUTER, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "HTTP-Referer": "https://contextfile.ai", "X-Title": "ContextFile listing uplift" },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          seed: req.seed,
          usage: { include: true },
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const data = (await res.json()) as any;
      const cost = data?.usage?.cost;
      return {
        text: typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "",
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        costUsd: typeof cost === "number" && cost >= 0 ? cost : null,
      };
    },
  };
}

/** Every task, in every arm, at every seed, for every model. One call at a time. */
export async function runProbe(input: {
  set: ProbeSet;
  models: readonly string[];
  seeds: readonly number[];
  contexts: { docs_summary: string; artifact: string };
  client: ProbeModelClient;
  temperature: number;
  maxTokens: number;
}): Promise<ProbeItem[]> {
  const items: ProbeItem[] = [];
  for (const model of input.models) {
    for (const task of input.set.tasks) {
      for (const arm of PROBE_ARMS as readonly ProbeArm[]) {
        const user = probeUserMessage(task.prompt, arm === "none" ? null : input.contexts[arm]);
        for (const seed of input.seeds) {
          try {
            const c = await input.client.complete({ model, system: PROBE_SYSTEM_PROMPT, user, temperature: input.temperature, maxTokens: input.maxTokens, seed });
            items.push(scoreProbe(task, model, arm, seed, c));
          } catch (e) {
            items.push(scoreProbe(task, model, arm, seed, { error: e instanceof Error ? e.message : String(e) }));
          }
        }
      }
    }
  }
  return items;
}

const stableJson = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

export function probeResultFileName(body: ProbeResultBody): string {
  return `${body.ranAt.slice(0, 10)}-v${body.artifact.version}-${body.harnessVersion}.json`;
}

const num = (v: string | undefined, fallback: number, name: string): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`[probe-uplift] --${name} must be a number (got "${v}")`);
  return n;
};

/** Example context sizes and prices for `estimate`, used when no flag is given. Not measured. */
export const ESTIMATE_EXAMPLES = Object.freeze({ models: 1, artifactTokens: 8000, summaryTokens: 2000, priceIn: 3, priceOut: 15 });

export async function runProbeCli(argv: readonly string[], env: Record<string, string | undefined> = process.env, deps: { client?: ProbeModelClient; now?: Date; root?: string } = {}): Promise<string> {
  const [command, ...rest] = argv;
  const root = deps.root ?? probeRoot();
  switch (command) {
    case "check": {
      const sets = loadProbeSets(root);
      const config = loadProbeRunConfig(root);
      const lines = [...sets.values()].map((s) => `  ${s.seedId}: ${s.tasks.length} tasks on ${s.subject} ${s.version}, digest ${probeSetDigest(s)}${s.reviewedBy ? `, reviewed by ${s.reviewedBy}` : ", not reviewed yet"}`);
      return [`[probe-uplift] ${sets.size} probe sets; seeds ${config.seeds}; models ${config.models.length ? config.models.join(", ") : "none configured (pass --model)"}`, ...lines].join("\n");
    }
    case "estimate": {
      const { values } = parseArgs({
        args: rest,
        options: { listing: { type: "string", multiple: true }, models: { type: "string" }, "artifact-tokens": { type: "string" }, "summary-tokens": { type: "string" }, "price-in": { type: "string" }, "price-out": { type: "string" } },
        strict: true,
      });
      const all = loadProbeSets(root);
      const config = loadProbeRunConfig(root);
      const picked = values.listing?.length ? values.listing.map((id) => all.get(id) ?? (() => { throw new Error(`[probe-uplift] no probe set for ${id}`); })()) : [...all.values()];
      const e = ESTIMATE_EXAMPLES;
      const models = num(values.models, config.models.length || e.models, "models");
      const est = estimateProbeRun({
        sets: picked,
        models,
        seeds: config.seeds,
        maxTokens: config.maxTokens,
        contextTokens: { artifact: num(values["artifact-tokens"], e.artifactTokens, "artifact-tokens"), docs_summary: num(values["summary-tokens"], e.summaryTokens, "summary-tokens") },
        pricePerMillion: { input: num(values["price-in"], e.priceIn, "price-in"), output: num(values["price-out"], e.priceOut, "price-out") },
      });
      const tasks = picked.reduce((n, s) => n + s.tasks.length, 0);
      return [
        `[probe-uplift] Estimate, not a measurement: tokens are characters over four, output assumes every answer uses maxTokens.`,
        `  ${picked.length} listings, ${tasks} tasks, 3 arms, ${config.seeds} seeds, ${models} model(s): ${est.calls} calls`,
        `  input about ${est.inputTokens.toLocaleString("en-US")} tokens, output at most ${est.outputTokensMax.toLocaleString("en-US")} tokens`,
        `  at $${num(values["price-in"], e.priceIn, "price-in")} in and $${num(values["price-out"], e.priceOut, "price-out")} out per million tokens: at most $${est.costUsdMax.toFixed(2)}`,
        `  Context sizes and prices without a flag are Example values; pass the real sizes from each artifact and the chosen model's prices.`,
      ].join("\n");
    }
    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: {
          listing: { type: "string" },
          artifact: { type: "string" },
          summary: { type: "string" },
          "summary-model": { type: "string" },
          "summary-source": { type: "string" },
          "artifact-id": { type: "string" },
          "artifact-version": { type: "string" },
          "listing-id": { type: "string" },
          "report-digest": { type: "string" },
          model: { type: "string", multiple: true },
          out: { type: "string" },
        },
        strict: true,
      });
      for (const k of ["listing", "artifact", "summary", "summary-model", "summary-source", "artifact-id", "artifact-version"] as const) if (!values[k]) throw new Error(`[probe-uplift] run needs --${k}`);
      const set = loadProbeSets(root).get(values.listing!);
      if (!set) throw new Error(`[probe-uplift] no probe set for ${values.listing}`);
      const config = loadProbeRunConfig(root);
      const models = values.model?.length ? values.model : config.models;
      if (models.length === 0) throw new Error("[probe-uplift] no models: pass --model <id> or list them in benchmarks/uplift/listings/config.json");
      const key = harnessModelKey(env);
      const client = deps.client ?? (key ? openRouterProbeClient(key) : null);
      if (!client) throw new Error("[probe-uplift] OPENROUTER_API_KEY is not set; the harness cannot call models");
      const artifact = readFileSync(values.artifact!, "utf8");
      const summary = readFileSync(values.summary!, "utf8");
      const seeds = Array.from({ length: config.seeds }, (_, i) => i + 1);
      const items = await runProbe({ set, models, seeds, contexts: { artifact, docs_summary: summary }, client, temperature: config.temperature, maxTokens: config.maxTokens });
      const body = buildProbeResultBody({
        set,
        artifact: {
          artifactId: values["artifact-id"]!,
          version: Number(values["artifact-version"]),
          contentDigest: sha(artifact),
          listingId: values["listing-id"] ?? null,
          reportDigest: values["report-digest"] ?? null,
        },
        summary: { digest: sha(summary), model: values["summary-model"]!, sourceUrl: values["summary-source"]! },
        config,
        seeds,
        items,
        ranAt: deps.now,
      });
      const signed = signProbeResult(body, new LocalDevSigner(env.REPORT_SIGNING_KEY_PEM));
      const out = values.out ?? join(root, set.seedId, "results", probeResultFileName(body));
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, stableJson(signed));
      const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
      const lines = body.models.map((m) => {
        const d = m.deltas.vsDocsSummary;
        return `  ${m.model}: pass rate none ${pct(m.arms.none.passRate)}, summary ${pct(m.arms.docs_summary.passRate)}, artifact ${pct(m.arms.artifact.passRate)}; artifact minus summary ${d ? `${d.estimate} [${d.low}, ${d.high}]` : "n/a"}`;
      });
      return [`[probe-uplift] wrote ${out} (artifact ${body.artifact.contentDigest}, ${roughTokens(artifact)} rough tokens)`, ...lines].join("\n");
    }
    default:
      throw new Error("[probe-uplift] commands: check | estimate [options] | run --listing <seed id> --artifact <file> --summary <file> ...");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProbeCli(process.argv.slice(2)).then(
    (msg) => {
      process.stdout.write(msg + "\n");
    },
    (e: unknown) => {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
      process.exit(1);
    }
  );
}
