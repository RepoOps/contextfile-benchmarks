// The uplift scorecard CLI (R10). Run from the repo root:
//
//   node --experimental-strip-types packages/core/src/uplift-cli.ts <command> [options]
//
//   manifest [--write]   rebuild benchmarks/uplift/manifest.json from the task files
//                        (without --write: fail when the committed manifest is stale)
//   check                validate the task set and the run config
//   run [--model <id>]... [--limit <n>] [--out <file>]
//                        run both arms for each model (default: config.json models) and
//                        write one signed result file. Needs OPENROUTER_API_KEY and, for
//                        the with arm, CONTEXTFILE_UPLIFT_TOKEN.
//   compare <published.json> <rerun.json>   does a rerun match within uplift_rerun_tolerance
//   due                  exit 0 and print "due" or "not due" against uplift_cadence_days
//   import-gitchameleon <dataset.jsonl>
//                        write the tasks picked in benchmarks/uplift/sources/gitchameleon.json
//                        from a GitChameleon 2.0 dataset file, then run manifest --write
//
// Signing: `run` signs with REPORT_SIGNING_KEY_PEM. Without it the result is signed by an
// ephemeral dev key and /benchmarks will not show it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildUpliftManifest,
  buildUpliftResultBody,
  compareUpliftRuns,
  isStale,
  loadUpliftResults,
  loadUpliftRunConfig,
  loadUpliftSet,
  readTaskTexts,
  scoreTranscript,
  SignedUpliftResultSchema,
  signUpliftResult,
  taskFromGitChameleon,
  upliftCadenceDays,
  upliftRerunTolerance,
  upliftRoot,
  UPLIFT_SYSTEM_PROMPT,
  type GitChameleonProblem,
  type UpliftArm,
  type UpliftItem,
  type UpliftResultBody,
  type UpliftRunConfig,
  type UpliftSet,
  type UpliftTask,
  type UpliftTranscript,
} from "./uplift.ts";
import { LocalDevSigner } from "./signing.ts";

const SET_ID = "contextfile-uplift";
const SET_VERSION = "0.2.0";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

type Fetch = typeof fetch;

/** A tool the with arm offers the model, in OpenAI function format. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The ContextFile side of the with arm: list the allowed tools, call one. */
export interface ToolServer {
  tools(): Promise<ToolDef[]>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * MCP over Streamable HTTP, JSON responses only: initialize, then tools/list and
 * tools/call with the session id. Only tools named in `allow` and not marked mutating
 * are offered, so a run can never buy, publish or write.
 */
export function mcpToolServer(url: string, token: string | undefined, allow: readonly string[], fetchImpl: Fetch = fetch): ToolServer {
  let session: string | null = null;
  let nextId = 1;
  const rpc = async (method: string, params?: unknown): Promise<any> => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (session) headers["mcp-session-id"] = session;
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
    if (!res.ok) throw new Error(`[uplift] MCP ${method} answered ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    const msg = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (msg.error) throw new Error(`[uplift] MCP ${method}: ${msg.error.message ?? "error"}`);
    return msg.result;
  };
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contextfile-uplift", version: "1" } }).then(() => undefined));
  return {
    async tools() {
      await init();
      const r = (await rpc("tools/list")) as { tools: { name: string; description?: string; inputSchema?: Record<string, unknown>; _meta?: { mutating?: boolean } }[] };
      return r.tools
        .filter((t) => allow.includes(t.name) && t._meta?.mutating !== true)
        .map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } }));
    },
    async call(name, args) {
      if (!allow.includes(name)) return JSON.stringify({ error: `tool ${name} is not offered in this run` });
      await init();
      try {
        const r = (await rpc("tools/call", { name, arguments: args })) as { content?: { type: string; text?: string }[] };
        return (r.content ?? []).map((c) => c.text ?? "").join("\n") || JSON.stringify(r);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

/** One model answering one task. The with arm gets tools; the without arm gets none. Same prompt either way. */
export interface ModelRunner {
  answer(model: string, task: UpliftTask, tools: ToolServer | null, limits: Pick<UpliftRunConfig, "maxTurns" | "maxTokens">): Promise<UpliftTranscript>;
}

/** OpenRouter chat completions with tool calling, temperature 0. */
export function openRouterRunner(apiKey: string, fetchImpl: Fetch = fetch): ModelRunner {
  return {
    async answer(model, task, tools, limits) {
      const defs = tools ? await tools.tools() : [];
      const messages: any[] = [
        { role: "system", content: UPLIFT_SYSTEM_PROMPT },
        { role: "user", content: task.prompt },
      ];
      const t: UpliftTranscript = { answer: "", toolCalls: 0, toolResults: [], promptTokens: 0, completionTokens: 0 };
      for (let turn = 0; turn < limits.maxTurns; turn++) {
        const body: Record<string, unknown> = { model, messages, temperature: 0, max_tokens: limits.maxTokens };
        if (defs.length) body.tools = defs.map((d) => ({ type: "function", function: d }));
        const res = await fetchImpl(OPENROUTER, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "HTTP-Referer": "https://contextfile.ai", "X-Title": "ContextFile uplift harness" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
        const data = (await res.json()) as any;
        t.promptTokens += data?.usage?.prompt_tokens ?? 0;
        t.completionTokens += data?.usage?.completion_tokens ?? 0;
        const msg = data?.choices?.[0]?.message ?? {};
        t.answer = typeof msg.content === "string" ? msg.content : "";
        const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!tools || calls.length === 0) return t;
        messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
        for (const c of calls) {
          t.toolCalls++;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function?.arguments || "{}");
          } catch {
            /* bad arguments: the server answers with a validation error */
          }
          const out = await tools.call(String(c.function?.name ?? ""), args);
          t.toolResults.push(out);
          messages.push({ role: "tool", tool_call_id: c.id, content: out.slice(0, 20000) });
        }
      }
      return t;
    },
  };
}

/** Run every task for every model in both arms, one task at a time per model. */
export async function runUplift(input: {
  set: UpliftSet;
  models: readonly string[];
  runner: ModelRunner;
  tools: ToolServer;
  limits: Pick<UpliftRunConfig, "maxTurns" | "maxTokens">;
  limit?: number;
}): Promise<UpliftItem[]> {
  const tasks = input.limit ? input.set.tasks.slice(0, input.limit) : input.set.tasks;
  const items: UpliftItem[] = [];
  for (const model of input.models) {
    for (const task of tasks) {
      for (const arm of ["with", "without"] as UpliftArm[]) {
        try {
          const t = await input.runner.answer(model, task, arm === "with" ? input.tools : null, input.limits);
          items.push(scoreTranscript(task, model, arm, t));
        } catch (e) {
          items.push(scoreTranscript(task, model, arm, { error: e instanceof Error ? e.message : String(e) }));
        }
      }
    }
  }
  return items;
}

const stableJson = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** The picked GitChameleon problems as tasks. A pick whose example is not in the file fails. */
export function importGitChameleon(datasetJsonl: string, sources: { picks: { exampleId: string; id: string; checks: UpliftTask["checks"] }[] }): UpliftTask[] {
  const byId = new Map<string, GitChameleonProblem>();
  for (const line of datasetJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as GitChameleonProblem;
    byId.set(String(p.example_id), p);
  }
  return sources.picks.map((pick) => {
    const p = byId.get(pick.exampleId);
    if (!p) throw new Error(`[uplift] GitChameleon example ${pick.exampleId} is not in the dataset file`);
    return taskFromGitChameleon(p, { id: pick.id, checks: pick.checks });
  });
}

export function resultFileName(body: UpliftResultBody): string {
  return `${body.ranAt.slice(0, 10)}-${body.harnessVersion}.json`;
}

export async function runUpliftCli(argv: readonly string[], env: Record<string, string | undefined> = process.env, deps: { fetchImpl?: Fetch; now?: Date } = {}): Promise<string> {
  const [command, ...rest] = argv;
  const root = upliftRoot();
  switch (command) {
    case "manifest": {
      const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" } }, strict: true });
      const text = stableJson(buildUpliftManifest(readTaskTexts(root), { id: SET_ID, version: SET_VERSION }));
      const file = join(root, "manifest.json");
      if (values.write) {
        writeFileSync(file, text);
        return `[uplift] wrote manifest`;
      }
      let current = "";
      try {
        current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      } catch {
        /* missing manifest is stale */
      }
      if (current !== text) throw new Error("[uplift] manifest.json is stale; run: uplift-cli.ts manifest --write");
      return "[uplift] manifest is current";
    }
    case "check": {
      const set = loadUpliftSet(root);
      const config = loadUpliftRunConfig(root);
      const libs = [...new Set(set.tasks.map((t) => `${t.library} ${t.version}`))];
      return [
        `[uplift] set ${set.manifest.id} ${set.manifest.version}, digest ${set.manifest.setDigest}`,
        `[uplift] tasks ${set.tasks.length} across ${libs.length} library versions`,
        `[uplift] models configured: ${config.models.length ? config.models.join(", ") : "none (pass --model)"}; tools: ${config.tools.join(", ")}`,
      ].join("\n");
    }
    case "run": {
      const { values } = parseArgs({ args: rest, options: { model: { type: "string", multiple: true }, limit: { type: "string" }, out: { type: "string" } }, strict: true });
      const config = loadUpliftRunConfig(root);
      const models = values.model?.length ? values.model : config.models;
      if (models.length === 0) throw new Error("[uplift] no models: pass --model <id> or list them in benchmarks/uplift/config.json");
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("[uplift] OPENROUTER_API_KEY is not set; the harness cannot call models");
      if (!env.CONTEXTFILE_UPLIFT_TOKEN) throw new Error("[uplift] CONTEXTFILE_UPLIFT_TOKEN is not set; the with arm cannot reach the ContextFile MCP server");
      const set = loadUpliftSet(root);
      const tools = mcpToolServer(config.mcpUrl, env.CONTEXTFILE_UPLIFT_TOKEN, config.tools, deps.fetchImpl);
      const offered = (await tools.tools()).map((t) => t.name);
      if (offered.length === 0) throw new Error("[uplift] the MCP server offered none of the configured tools; the with arm would equal the without arm");
      const items = await runUplift({ set, models, runner: openRouterRunner(apiKey, deps.fetchImpl), tools, limits: config, limit: values.limit ? Number(values.limit) : undefined });
      const body = buildUpliftResultBody({ set, server: { url: config.mcpUrl, tools: offered }, items, ranAt: deps.now });
      const signed = signUpliftResult(body, new LocalDevSigner(env.REPORT_SIGNING_KEY_PEM));
      const out = values.out ?? join(root, "results", resultFileName(body));
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, stableJson(signed));
      const lines = body.models.map((m) => `  ${m.model}: accuracy with ${m.arms.with.metrics.accuracy} without ${m.arms.without.metrics.accuracy}; call rate ${m.arms.with.metrics.callRate}`);
      return [`[uplift] wrote ${out}${values.limit ? " (partial run: not comparable to a full result)" : ""}`, ...lines].join("\n");
    }
    case "compare": {
      const [a, b] = rest;
      if (!a || !b) throw new Error("[uplift] usage: compare <published.json> <rerun.json>");
      const pub = SignedUpliftResultSchema.parse(JSON.parse(readFileSync(a, "utf8")));
      const re = SignedUpliftResultSchema.parse(JSON.parse(readFileSync(b, "utf8")));
      const tol = upliftRerunTolerance();
      const c = compareUpliftRuns(pub.body, re.body, tol);
      if (!c.match) throw new Error(`[uplift] rerun does not match (tolerance ${tol}):\n  ${c.problems.join("\n  ")}`);
      return `[uplift] rerun matches within ${tol}`;
    }
    case "due": {
      const latest = loadUpliftResults(root).results.find((r) => r.check.publishable) ?? null;
      const cadence = upliftCadenceDays();
      const ranAt = latest?.result.body.ranAt ?? null;
      return isStale(ranAt, cadence, deps.now) ? `due (last run ${ranAt ?? "never"}, cadence ${cadence} days)` : `not due (last run ${ranAt}, cadence ${cadence} days)`;
    }
    case "import-gitchameleon": {
      const [dataset] = rest;
      if (!dataset) throw new Error("[uplift] usage: import-gitchameleon <dataset.jsonl>");
      const written = importGitChameleon(readFileSync(dataset, "utf8"), JSON.parse(readFileSync(join(root, "sources", "gitchameleon.json"), "utf8")));
      for (const t of written) writeFileSync(join(root, "tasks", `${t.id}.json`), stableJson(t));
      return `[uplift] wrote ${written.length} GitChameleon tasks; now run: uplift-cli.ts manifest --write`;
    }
    default:
      throw new Error("[uplift] commands: manifest [--write] | check | run | compare <a> <b> | due | import-gitchameleon <dataset.jsonl>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runUpliftCli(process.argv.slice(2)).then(
    (msg) => {
      process.stdout.write(msg + "\n");
    },
    (e: unknown) => {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
      process.exit(1);
    }
  );
}
