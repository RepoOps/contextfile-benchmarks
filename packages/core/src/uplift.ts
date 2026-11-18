// The uplift scorecard harness (R10). Runs the same model on a version-conditioned task
// set twice, with the ContextFile MCP server present and absent, and publishes per
// model and arm: task accuracy, call rate, tokens per answer and misgrounded-citation
// rate. Every result carries the model ids, run date, harness version, prompt hash and
// task set digest, and is signed like a golden-set result (R6).
//
// Layout (repo root):
//   benchmarks/uplift/manifest.json   set id, version, per-task digests, set digest
//   benchmarks/uplift/tasks/*.json    one task per file
//   benchmarks/uplift/config.json     models, MCP URL and tool allowlist for a run
//   benchmarks/uplift/results/*.json  signed results, newest by ranAt wins
//
// Task prompts, tool results and model answers are DATA, never instructions (Ground
// Rule 4): a task prompt reaches the model only as the user message, and tool results
// are only scanned for references and evidence patterns.
//
// Like golden-set.ts this module holds no secret, so it can be copied to the public
// harness repo as is. The model and MCP clients live in uplift-cli.ts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "./report.ts";
import { verifySignature, type Signer, type Signature } from "./signing.ts";
import { constantsTable } from "./constants.ts";
import { benchmarksRoot } from "./golden-set.ts";

export const UPLIFT_HARNESS_VERSION = "uplift-harness-1";
export const UPLIFT_RESULT_KIND = "contextfile.benchmark.uplift/v1";
export const UPLIFT_ARMS = ["with", "without"] as const;
export type UpliftArm = (typeof UPLIFT_ARMS)[number];

/** The one system prompt both arms share. Only the tool list differs between arms. */
export const UPLIFT_PROMPT_VERSION = "uplift-prompt-1";
export const UPLIFT_SYSTEM_PROMPT = [
  "You are a software engineer answering a coding question about a specific library version.",
  "Answer with working code for exactly the version named in the question, then one short sentence of explanation.",
  "If you use a ContextFile source, cite it inline as [cf:<id>] with the artifact id or report digest the source returned.",
  "Do not cite a source you did not read.",
].join("\n");

export function upliftPromptHash(): string {
  return sha(UPLIFT_SYSTEM_PROMPT);
}

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const round4 = (x: number) => Math.round(x * 10000) / 10000;
const ratio = (num: number, den: number) => (den === 0 ? null : round4(num / den));

export class UpliftError extends Error {
  constructor(message: string) {
    super(`[contextfile] uplift: ${message}`);
    this.name = "UpliftError";
  }
}

// ---------------------------------------------------------------------------
// Task set (tasks 1.1, 1.4)
// ---------------------------------------------------------------------------

const regexString = z.string().min(1).refine((s) => {
  try {
    new RegExp(s, "m");
    return true;
  } catch {
    return false;
  }
}, "not a valid regular expression");

export const UpliftTaskSchema = z
  .object({
    id: z.string().regex(/^ut-\d{4}$/),
    title: z.string().min(1),
    /** The library and exact version the task is conditioned on. */
    library: z.string().min(1),
    version: z.string().min(1),
    /** SPDX id. Only licenses that permit publishing results enter the set. */
    license: z.string().min(1),
    provenance: z.enum(["authored", "public"]),
    sourceUrl: z.string().url().optional(),
    prompt: z.string().min(1),
    /** The answer passes when every mustMatch pattern matches and no mustNotMatch does. */
    checks: z.object({ mustMatch: z.array(regexString).min(1), mustNotMatch: z.array(regexString).default([]) }),
    /** A citation is grounded only when a tool result that names the cited id also
     *  matches one of these. Empty: naming the id in a tool result is enough. */
    evidence: z.array(regexString).default([]),
  })
  .superRefine((t, ctx) => {
    if (t.provenance === "public" && !t.sourceUrl) ctx.addIssue({ code: "custom", message: "a public task needs sourceUrl" });
  });
export type UpliftTask = z.infer<typeof UpliftTaskSchema>;

/** SPDX ids whose terms permit publishing the tasks and results in a public repo. */
export const UPLIFT_PUBLISHABLE_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "MIT", "Apache-2.0", "public-domain"]);

/** GitChameleon 2.0 (owner decision 2026-11-09): harness Apache-2.0, dataset MIT. Tasks
 *  are taken from the dataset file at one pinned commit. */
export const GITCHAMELEON = Object.freeze({
  repo: "https://github.com/mrcabbage972/GitChameleonBenchmark",
  commit: "3a1b6045a6b2a276bd24d715589cb041f8eccb93",
  license: "MIT",
});

/** The fields of one GitChameleon 2.0 problem this harness reads. */
export interface GitChameleonProblem {
  example_id: string;
  library: string;
  version: string;
  python_version: string;
  problem: string;
  starting_code: string;
  name_of_class_or_func: string;
}

/**
 * One GitChameleon problem as a harness task. The dataset grades by running unit tests;
 * this harness cannot, so a person writes the pattern checks for each converted task
 * (the API the version calls for, and the one it replaced). The problem text is data:
 * it goes into the prompt as the question and nowhere else.
 */
export function taskFromGitChameleon(p: GitChameleonProblem, o: { id: string; checks: UpliftTask["checks"] }): UpliftTask {
  const prompt = [
    `Using ${p.library} ${p.version} on Python ${p.python_version}: ${p.problem.trim()}`,
    "",
    "Complete this code:",
    "",
    p.starting_code.replace(/\s+$/, ""),
  ].join("\n");
  return UpliftTaskSchema.parse({
    id: o.id,
    title: `GitChameleon ${p.example_id}: ${p.name_of_class_or_func} in ${p.library} ${p.version}`,
    library: p.library,
    version: p.version,
    license: GITCHAMELEON.license,
    provenance: "public",
    sourceUrl: `${GITCHAMELEON.repo}/blob/${GITCHAMELEON.commit}/dataset/dataset.jsonl#example_id=${p.example_id}`,
    prompt,
    checks: o.checks,
    evidence: [],
  });
}

export const UpliftManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  tasks: z.array(z.object({ id: z.string(), file: z.string(), digest: z.string() })),
  setDigest: z.string(),
});
export type UpliftManifest = z.infer<typeof UpliftManifestSchema>;

export interface UpliftSet {
  manifest: UpliftManifest;
  tasks: UpliftTask[];
}

export function taskDigest(task: UpliftTask): string {
  return sha(canonicalize(task));
}

export function upliftSetDigest(tasks: readonly { id: string; digest: string }[]): string {
  return sha(canonicalize([...tasks].sort((a, b) => a.id.localeCompare(b.id)).map((t) => ({ id: t.id, digest: t.digest }))));
}

export function buildUpliftManifest(taskTexts: Record<string, string>, meta: { id: string; version: string }): UpliftManifest {
  const tasks = Object.entries(taskTexts)
    .map(([file, text]) => {
      const task = UpliftTaskSchema.parse(JSON.parse(text));
      return { id: task.id, file, digest: taskDigest(task) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ...meta, tasks, setDigest: upliftSetDigest(tasks) };
}

export function parseUpliftSet(manifestText: string, taskTexts: Record<string, string>): UpliftSet {
  const manifest = UpliftManifestSchema.parse(JSON.parse(manifestText));
  const tasks: UpliftTask[] = [];
  for (const entry of manifest.tasks) {
    const text = taskTexts[entry.file];
    if (text === undefined) throw new UpliftError(`${entry.file} is in the manifest but missing`);
    const parsed = UpliftTaskSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new UpliftError(`${entry.file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const task = parsed.data;
    if (task.id !== entry.id) throw new UpliftError(`${entry.file} holds ${task.id}, manifest says ${entry.id}`);
    if (!UPLIFT_PUBLISHABLE_LICENSES.has(task.license)) throw new UpliftError(`${task.id}: license ${task.license} does not permit publishing results`);
    const d = taskDigest(task);
    if (d !== entry.digest) throw new UpliftError(`${task.id}: digest ${d} does not match the manifest (${entry.digest}); rerun the manifest command`);
    tasks.push(task);
  }
  const extra = Object.keys(taskTexts).filter((f) => !manifest.tasks.some((t) => t.file === f));
  if (extra.length) throw new UpliftError(`not in the manifest: ${extra.join(", ")}`);
  const sd = upliftSetDigest(manifest.tasks);
  if (sd !== manifest.setDigest) throw new UpliftError(`set digest ${sd} does not match the manifest (${manifest.setDigest})`);
  return { manifest, tasks };
}

export function upliftRoot(root: string = benchmarksRoot()): string {
  return join(root, "uplift");
}

export function readTaskTexts(root: string = upliftRoot()): Record<string, string> {
  const dir = join(root, "tasks");
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) out[`tasks/${f}`] = readFileSync(join(dir, f), "utf8");
  return out;
}

export function loadUpliftSet(root: string = upliftRoot()): UpliftSet {
  return parseUpliftSet(readFileSync(join(root, "manifest.json"), "utf8"), readTaskTexts(root));
}

export const UpliftRunConfigSchema = z.object({
  /** OpenRouter model ids to score. Each runs both arms. */
  models: z.array(z.string().min(1)),
  /** The ContextFile MCP endpoint the with arm connects to. */
  mcpUrl: z.string().url(),
  /** Read-only tools the with arm may call. Mutating tools are never offered. */
  tools: z.array(z.string().min(1)).min(1),
  /** Model turns per task before the harness stops and grades the last answer. */
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});
export type UpliftRunConfig = z.infer<typeof UpliftRunConfigSchema>;

export function loadUpliftRunConfig(root: string = upliftRoot()): UpliftRunConfig {
  return UpliftRunConfigSchema.parse(JSON.parse(readFileSync(join(root, "config.json"), "utf8")));
}

// ---------------------------------------------------------------------------
// Grading and citations (task 1.3)
// ---------------------------------------------------------------------------

/** How this harness grades, stated on every result (owner decision 2026-11-09). A task
 *  set such as GitChameleon 2.0 ships unit tests; this harness does not run them, so a
 *  result must never read as test-graded. */
export const UPLIFT_GRADING = Object.freeze({
  method: "pattern_checks",
  label: "Graded by pattern checks on the answer text, not by running tests.",
} as const);

export function gradeAnswer(task: Pick<UpliftTask, "checks">, answer: string): boolean {
  return task.checks.mustMatch.every((p) => new RegExp(p, "m").test(answer)) && !task.checks.mustNotMatch.some((p) => new RegExp(p, "m").test(answer));
}

/** Every distinct [cf:<id>] the answer cites, in order of first appearance. */
export function extractCitations(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\[cf:([^\]\s]+)\]/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * A citation is grounded when some tool result in the same run names the cited id and,
 * if the task lists evidence patterns, that same result matches one of them. Anything
 * else is misgrounded: an id the model never read, or a source that does not hold the
 * fact. In the without arm there are no tool results, so every citation is misgrounded.
 */
export function groundCitations(citations: readonly string[], toolResults: readonly string[], evidence: readonly string[]): { ref: string; grounded: boolean }[] {
  return citations.map((ref) => ({
    ref,
    grounded: toolResults.some((r) => r.includes(ref) && (evidence.length === 0 || evidence.some((p) => new RegExp(p, "m").test(r)))),
  }));
}

/** One task answered by one model in one arm. `error` is set when the model call failed. */
export interface UpliftItem {
  taskId: string;
  model: string;
  arm: UpliftArm;
  passed: boolean;
  error: string | null;
  toolCalls: number;
  tokens: number;
  citations: { ref: string; grounded: boolean }[];
}

export interface UpliftTranscript {
  answer: string;
  toolCalls: number;
  toolResults: string[];
  promptTokens: number;
  completionTokens: number;
}

export function scoreTranscript(task: UpliftTask, model: string, arm: UpliftArm, t: UpliftTranscript | { error: string }): UpliftItem {
  if ("error" in t) return { taskId: task.id, model, arm, passed: false, error: t.error.slice(0, 200), toolCalls: 0, tokens: 0, citations: [] };
  return {
    taskId: task.id,
    model,
    arm,
    passed: gradeAnswer(task, t.answer),
    error: null,
    toolCalls: t.toolCalls,
    tokens: t.promptTokens + t.completionTokens,
    citations: groundCitations(extractCitations(t.answer), t.toolResults, task.evidence),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface UpliftCounts {
  tasks: number;
  passed: number;
  errors: number;
  tasksWithCalls: number;
  citations: number;
  misgroundedCitations: number;
  tokens: number;
}

export interface UpliftMetrics {
  /** Of tasks, the share whose answer passed the task's checks. */
  accuracy: number | null;
  /** Of tasks, the share where the model called a ContextFile tool at least once. Null in the without arm (no server). */
  callRate: number | null;
  /** Mean prompt plus completion tokens per answered task (failed calls excluded). */
  tokensPerAnswer: number | null;
  /** Of [cf:] citations in answers, the share not backed by a tool result holding the evidence. */
  misgroundedRate: number | null;
}

export function countItems(items: readonly UpliftItem[]): UpliftCounts {
  const c: UpliftCounts = { tasks: 0, passed: 0, errors: 0, tasksWithCalls: 0, citations: 0, misgroundedCitations: 0, tokens: 0 };
  for (const i of items) {
    c.tasks++;
    if (i.passed) c.passed++;
    if (i.error !== null) c.errors++;
    if (i.toolCalls > 0) c.tasksWithCalls++;
    c.citations += i.citations.length;
    c.misgroundedCitations += i.citations.filter((x) => !x.grounded).length;
    c.tokens += i.tokens;
  }
  return c;
}

export function computeUpliftMetrics(c: UpliftCounts, arm: UpliftArm): UpliftMetrics {
  const answered = c.tasks - c.errors;
  return {
    accuracy: ratio(c.passed, c.tasks),
    callRate: arm === "with" ? ratio(c.tasksWithCalls, c.tasks) : null,
    tokensPerAnswer: answered === 0 ? null : Math.round(c.tokens / answered),
    misgroundedRate: ratio(c.misgroundedCitations, c.citations),
  };
}

/** Per-artifact uplift: tasks where the with arm cited the artifact and the citation was grounded. */
export interface ArtifactUplift {
  ref: string;
  tasks: number;
  withAccuracy: number;
  withoutAccuracy: number;
}

export function perArtifactUplift(items: readonly UpliftItem[], model: string): ArtifactUplift[] {
  const withItems = items.filter((i) => i.model === model && i.arm === "with");
  const without = new Map(items.filter((i) => i.model === model && i.arm === "without").map((i) => [i.taskId, i]));
  const byRef = new Map<string, string[]>();
  for (const i of withItems) for (const c of i.citations) if (c.grounded) byRef.set(c.ref, [...(byRef.get(c.ref) ?? []), i.taskId]);
  const out: ArtifactUplift[] = [];
  for (const [ref, taskIds] of byRef) {
    const ids = taskIds.filter((id) => without.has(id));
    if (ids.length === 0) continue;
    const w = withItems.filter((i) => ids.includes(i.taskId));
    out.push({ ref, tasks: ids.length, withAccuracy: round4(w.filter((i) => i.passed).length / ids.length), withoutAccuracy: round4(ids.filter((id) => without.get(id)!.passed).length / ids.length) });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

// ---------------------------------------------------------------------------
// Result file (tasks 1.4, 2.3)
// ---------------------------------------------------------------------------

const nullableRatio = z.number().min(0).max(1).nullable();
const MetricsSchema = z.object({ accuracy: nullableRatio, callRate: nullableRatio, tokensPerAnswer: z.number().int().min(0).nullable(), misgroundedRate: nullableRatio });
const CountsSchema = z.object({
  tasks: z.number().int(),
  passed: z.number().int(),
  errors: z.number().int(),
  tasksWithCalls: z.number().int(),
  citations: z.number().int(),
  misgroundedCitations: z.number().int(),
  tokens: z.number().int(),
});
const ArmSchema = z.object({ metrics: MetricsSchema, counts: CountsSchema });

export const UpliftResultBodySchema = z.object({
  kind: z.literal(UPLIFT_RESULT_KIND),
  harnessVersion: z.string().min(1),
  /** How answers were graded. Required, so no result can leave it out. */
  grading: z.object({ method: z.literal(UPLIFT_GRADING.method), label: z.string().min(1) }),
  ranAt: z.string().datetime(),
  set: z.object({ id: z.string(), version: z.string(), digest: z.string(), tasks: z.number().int() }),
  prompt: z.object({ version: z.string().min(1), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
  /** What the with arm connected to. The without arm runs the same model and prompt with no tools. */
  server: z.object({ url: z.string().url(), tools: z.array(z.string()) }),
  models: z.array(
    z.object({
      model: z.string().min(1),
      arms: z.object({ with: ArmSchema, without: ArmSchema }),
      perArtifact: z.array(z.object({ ref: z.string(), tasks: z.number().int().positive(), withAccuracy: z.number().min(0).max(1), withoutAccuracy: z.number().min(0).max(1) })),
    })
  ).min(1),
  items: z.array(
    z.object({
      taskId: z.string(),
      model: z.string(),
      arm: z.enum(UPLIFT_ARMS),
      passed: z.boolean(),
      error: z.string().nullable(),
      toolCalls: z.number().int().min(0),
      tokens: z.number().int().min(0),
      citations: z.array(z.object({ ref: z.string(), grounded: z.boolean() })),
    })
  ),
});
export type UpliftResultBody = z.infer<typeof UpliftResultBodySchema>;

export const SignedUpliftResultSchema = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  body: UpliftResultBodySchema,
  signature: z.object({ keyId: z.string(), alg: z.literal("Ed25519"), value: z.string() }),
  publicKey: z.string().min(1),
});
export type SignedUpliftResult = z.infer<typeof SignedUpliftResultSchema>;

export function buildUpliftResultBody(input: {
  set: UpliftSet;
  server: UpliftResultBody["server"];
  items: UpliftItem[];
  ranAt?: Date;
}): UpliftResultBody {
  const models = [...new Set(input.items.map((i) => i.model))];
  const arm = (model: string, a: UpliftArm) => {
    const counts = countItems(input.items.filter((i) => i.model === model && i.arm === a));
    return { metrics: computeUpliftMetrics(counts, a), counts };
  };
  return UpliftResultBodySchema.parse({
    kind: UPLIFT_RESULT_KIND,
    harnessVersion: UPLIFT_HARNESS_VERSION,
    grading: { method: UPLIFT_GRADING.method, label: UPLIFT_GRADING.label },
    ranAt: (input.ranAt ?? new Date()).toISOString(),
    set: { id: input.set.manifest.id, version: input.set.manifest.version, digest: input.set.manifest.setDigest, tasks: input.set.tasks.length },
    prompt: { version: UPLIFT_PROMPT_VERSION, hash: upliftPromptHash() },
    server: input.server,
    models: models.map((model) => ({ model, arms: { with: arm(model, "with"), without: arm(model, "without") }, perArtifact: perArtifactUplift(input.items, model) })),
    items: input.items,
  });
}

export function digestUpliftBody(body: UpliftResultBody): string {
  return sha(canonicalize(body));
}

export function signUpliftResult(body: UpliftResultBody, signer: Signer & { publicKeyPem(): string }): SignedUpliftResult {
  const digest = digestUpliftBody(body);
  return { digest, body, signature: signer.sign(digest), publicKey: signer.publicKeyPem() };
}

export interface UpliftResultCheck {
  digestValid: boolean;
  signatureValid: boolean;
  stableKey: boolean;
  publishable: boolean;
}

export function checkUpliftResult(r: SignedUpliftResult): UpliftResultCheck {
  const digestValid = digestUpliftBody(r.body) === r.digest;
  const signatureValid = verifySignature(r.digest, r.signature as Signature, r.publicKey);
  const stableKey = r.signature.keyId.startsWith("pem-");
  return { digestValid, signatureValid, stableKey, publishable: digestValid && signatureValid && stableKey };
}

export interface LoadedUpliftResult {
  file: string;
  result: SignedUpliftResult;
  check: UpliftResultCheck;
}

/** Every result file, newest run first; files that do not parse are reported. Prior runs stay as history. */
export function loadUpliftResults(root: string = upliftRoot()): { results: LoadedUpliftResult[]; invalid: { file: string; reason: string }[] } {
  const dir = join(root, "results");
  const results: LoadedUpliftResult[] = [];
  const invalid: { file: string; reason: string }[] = [];
  if (!existsSync(dir)) return { results, invalid };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const result = SignedUpliftResultSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      results.push({ file: f, result, check: checkUpliftResult(result) });
    } catch (e) {
      invalid.push({ file: f, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  results.sort((a, b) => b.result.body.ranAt.localeCompare(a.result.body.ranAt));
  return { results, invalid };
}

// ---------------------------------------------------------------------------
// Schedule (task 2.1)
// ---------------------------------------------------------------------------

/** The rerun cadence in days, from config/constants.md (`uplift_cadence_days`, Example). */
export function upliftCadenceDays(markdown?: string): number {
  const raw = constantsTable(markdown).get("uplift_cadence_days");
  if (raw === undefined) throw new UpliftError(`"uplift_cadence_days" is missing from config/constants.md`);
  const n = Number(raw.replace(/\s/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new UpliftError(`"uplift_cadence_days" must be a whole number of days (got "${raw}")`);
  return n;
}

/** Largest accuracy difference a rerun may show and still match (`uplift_rerun_tolerance`, Example). */
export function upliftRerunTolerance(markdown?: string): number {
  const raw = constantsTable(markdown).get("uplift_rerun_tolerance");
  if (raw === undefined) throw new UpliftError(`"uplift_rerun_tolerance" is missing from config/constants.md`);
  const n = Number(raw.replace(/\s/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new UpliftError(`"uplift_rerun_tolerance" must be a number from 0 to 1 (got "${raw}")`);
  return n;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A scorecard is stale (and a rerun due) when no run exists or the newest is older than the cadence. */
export function isStale(latestRanAt: string | null, cadenceDays: number, now: Date = new Date()): boolean {
  if (latestRanAt === null) return true;
  return now.getTime() - new Date(latestRanAt).getTime() > cadenceDays * DAY_MS;
}

/** Compare a rerun with a published result: same set and prompt, and each accuracy within `tolerance`. */
export function compareUpliftRuns(published: UpliftResultBody, rerun: UpliftResultBody, tolerance: number): { match: boolean; problems: string[] } {
  const problems: string[] = [];
  if (published.set.digest !== rerun.set.digest) problems.push(`task set digest differs (${published.set.digest} vs ${rerun.set.digest})`);
  if (published.prompt.hash !== rerun.prompt.hash) problems.push("prompt hash differs");
  for (const p of published.models) {
    const r = rerun.models.find((m) => m.model === p.model);
    if (!r) {
      problems.push(`${p.model} is missing from the rerun`);
      continue;
    }
    for (const arm of UPLIFT_ARMS) {
      const a = p.arms[arm].metrics.accuracy;
      const b = r.arms[arm].metrics.accuracy;
      if (a === null || b === null ? a !== b : Math.abs(a - b) > tolerance + 1e-9) problems.push(`${p.model} ${arm} accuracy ${a} vs ${b} (tolerance ${tolerance})`);
    }
  }
  return { match: problems.length === 0, problems };
}
