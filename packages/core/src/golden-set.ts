// The golden set and its accuracy harness (R6). Measures the pinned judge against
// labeled claims and publishes precision, recall and misgrounded rate, each result
// carrying the judge model, judge prompt hash, harness version, set digest and date.
//
// Layout (repo root):
//   benchmarks/golden-set/manifest.json   set id, version, target size, per-work digests, set digest
//   benchmarks/golden-set/works/*.json    one labeled work per file
//   benchmarks/results/*.json             signed results, newest by ranAt wins
//   benchmarks/judge-gate.json            the judge allowed to stand without a passing result
//   benchmarks/judge-prompt.json          the live judge prompt text, version and hash (from judge.ts)
//
// Everything read from the set is DATA, never instructions (Ground Rule 4): passages
// and claims only ever reach the judge inside its CLAIM / SOURCE PASSAGE slots.
//
// This module holds no secret, so it can be copied to the public harness repo as is.
// The live judge prompt is public in judge.ts and benchmarks/judge-prompt.json. The judge backends that need a key live in golden-cli.ts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ARTIFACT_TYPES } from "./types/registry.ts";
import { canonicalize } from "./report.ts";
import { verifySignature, type Signer, type Signature } from "./signing.ts";
import { constantsTable } from "./constants.ts";

export const GOLDEN_HARNESS_VERSION = "golden-harness-1";
export const GOLDEN_RESULT_KIND = "contextfile.benchmark.golden/v1";

// ---------------------------------------------------------------------------
// Label schema (task 1.1)
// ---------------------------------------------------------------------------

/** supported: the cited passage states the claim. wrong: the claim is false and the
 *  passage contradicts it. misgrounded: the claim may be true, but the cited passage
 *  does not support it (the failure claim-to-source binding exists to catch). */
export const GOLDEN_VERDICTS = ["supported", "wrong", "misgrounded"] as const;
export const GOLDEN_STAGES = ["pilot", "full"] as const;
export type GoldenStage = (typeof GOLDEN_STAGES)[number];
export type GoldenVerdict = (typeof GOLDEN_VERDICTS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const GoldenLabelSchema = z.object({
  labeler: z.string().min(1),
  verdict: z.enum(GOLDEN_VERDICTS),
  date: isoDate,
});

export const GoldenClaimSchema = z.object({
  id: z.string().regex(/^c\d+$/),
  text: z.string().min(1),
  sourceId: z.string().min(1),
  expected: z.enum(GOLDEN_VERDICTS),
  labels: z.array(GoldenLabelSchema).min(1),
});

export const GoldenSourceSchema = z.object({
  id: z.string().min(1),
  locator: z.string().min(1),
  content: z.string().min(1),
});

export const GoldenWorkSchema = z
  .object({
    id: z.string().regex(/^gw-\d{4}$/),
    artifactType: z.enum(ARTIFACT_TYPES),
    title: z.string().min(1),
    /** SPDX id. Only licenses that permit publication enter the set. */
    license: z.string().min(1),
    /** authored: written for the set. public: taken from a public source named in sourceUrl. */
    provenance: z.enum(["authored", "public"]),
    sourceUrl: z.string().url().optional(),
    sources: z.array(GoldenSourceSchema).min(1),
    claims: z.array(GoldenClaimSchema).min(1),
  })
  .superRefine((w, ctx) => {
    const ids = new Set(w.sources.map((s) => s.id));
    const seen = new Set<string>();
    for (const c of w.claims) {
      if (!ids.has(c.sourceId)) ctx.addIssue({ code: "custom", message: `${c.id} cites unknown source ${c.sourceId}` });
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `${c.id} appears twice` });
      seen.add(c.id);
    }
    if (w.provenance === "public" && !w.sourceUrl) ctx.addIssue({ code: "custom", message: "a public work needs sourceUrl" });
  });
export type GoldenWork = z.infer<typeof GoldenWorkSchema>;

/** SPDX ids whose terms permit republishing the passages in a public repo. */
export const PUBLISHABLE_LICENSES = new Set(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "PDDL-1.0", "MIT", "Apache-2.0", "public-domain"]);

export const GoldenManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /** Works the launch checklist requires (220). The page shows curated against target. */
  targetWorks: z.number().int().positive(),
  /** pilot: published before the set reaches its target, and labeled a pilot wherever
   *  it or a result on it is shown (owner decision 2026-11-11). full: the target set. */
  stage: z.enum(GOLDEN_STAGES).default("full"),
  works: z.array(z.object({ id: z.string(), file: z.string(), digest: z.string() })),
  setDigest: z.string(),
});
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;

export interface GoldenSet {
  manifest: GoldenManifest;
  works: GoldenWork[];
}

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(`[contextfile] golden set: ${message}`);
    this.name = "GoldenSetError";
  }
}

// ---------------------------------------------------------------------------
// Digests (task 1.4)
// ---------------------------------------------------------------------------

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

/** A work's digest covers its canonical JSON, so whitespace never changes it. */
export function workDigest(work: GoldenWork): string {
  return sha(canonicalize(work));
}

/** The set digest covers the ordered list of (id, digest) pairs. */
export function setDigest(works: readonly { id: string; digest: string }[]): string {
  const pairs = [...works].sort((a, b) => a.id.localeCompare(b.id)).map((w) => ({ id: w.id, digest: w.digest }));
  return sha(canonicalize(pairs));
}

/** Parse and check every work, then check the manifest digests against them. */
export function parseGoldenSet(manifestText: string, workTexts: Record<string, string>): GoldenSet {
  const manifest = GoldenManifestSchema.parse(JSON.parse(manifestText));
  const works: GoldenWork[] = [];
  for (const entry of manifest.works) {
    const text = workTexts[entry.file];
    if (text === undefined) throw new GoldenSetError(`${entry.file} is in the manifest but missing`);
    const parsed = GoldenWorkSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new GoldenSetError(`${entry.file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const work = parsed.data;
    if (work.id !== entry.id) throw new GoldenSetError(`${entry.file} holds ${work.id}, manifest says ${entry.id}`);
    if (!PUBLISHABLE_LICENSES.has(work.license)) throw new GoldenSetError(`${work.id}: license ${work.license} does not permit publication`);
    const d = workDigest(work);
    if (d !== entry.digest) throw new GoldenSetError(`${work.id}: digest ${d} does not match the manifest (${entry.digest}); rerun the manifest command`);
    works.push(work);
  }
  const extra = Object.keys(workTexts).filter((f) => !manifest.works.some((w) => w.file === f));
  if (extra.length) throw new GoldenSetError(`not in the manifest: ${extra.join(", ")}`);
  const sd = setDigest(manifest.works);
  if (sd !== manifest.setDigest) throw new GoldenSetError(`set digest ${sd} does not match the manifest (${manifest.setDigest})`);
  return { manifest, works };
}

/** Build a manifest from work files (the `manifest` command writes this). */
export function buildManifest(
  workTexts: Record<string, string>,
  meta: { id: string; version: string; targetWorks: number; stage?: GoldenStage }
): GoldenManifest {
  const works = Object.entries(workTexts)
    .map(([file, text]) => {
      const work = GoldenWorkSchema.parse(JSON.parse(text));
      return { id: work.id, file, digest: workDigest(work) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { id: meta.id, version: meta.version, targetWorks: meta.targetWorks, stage: meta.stage ?? "full", works, setDigest: setDigest(works) };
}

/** packages/core/src -> repo root, with the cwd fallbacks a Next build needs. */
export function benchmarksRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "benchmarks"),
    resolve(process.cwd(), "benchmarks"),
    resolve(process.cwd(), "..", "..", "benchmarks"),
  ];
  return candidates.find((c) => existsSync(join(c, "golden-set", "manifest.json"))) ?? candidates[0]!;
}

export function readWorkTexts(root: string = benchmarksRoot()): Record<string, string> {
  const dir = join(root, "golden-set", "works");
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) out[`works/${f}`] = readFileSync(join(dir, f), "utf8");
  return out;
}

export function loadGoldenSet(root: string = benchmarksRoot()): GoldenSet {
  return parseGoldenSet(readFileSync(join(root, "golden-set", "manifest.json"), "utf8"), readWorkTexts(root));
}

/** Every claim of the set, flattened, with a set-wide id (work id + claim id). */
export interface GoldenItem {
  id: string;
  workId: string;
  artifactType: GoldenWork["artifactType"];
  claim: string;
  passage: string;
  expected: GoldenVerdict;
}

export function goldenItems(set: GoldenSet): GoldenItem[] {
  return set.works.flatMap((w) =>
    w.claims.map((c) => ({
      id: `${w.id}/${c.id}`,
      workId: w.id,
      artifactType: w.artifactType,
      claim: c.text,
      passage: w.sources.find((s) => s.id === c.sourceId)!.content,
      expected: c.expected,
    }))
  );
}

// ---------------------------------------------------------------------------
// Inter-labeler agreement (task 1.3)
// ---------------------------------------------------------------------------

export interface Agreement {
  /** Claims with labels from two or more distinct labelers. */
  doubleLabeled: number;
  /** Share of those where the first two labelers agree. */
  observed: number | null;
  /** Cohen's kappa over the first two labelers of each double-labeled claim. */
  kappa: number | null;
}

export function interLabelerAgreement(works: readonly GoldenWork[]): Agreement {
  const pairs: [GoldenVerdict, GoldenVerdict][] = [];
  for (const w of works) {
    for (const c of w.claims) {
      const byLabeler = new Map<string, GoldenVerdict>();
      for (const l of c.labels) if (!byLabeler.has(l.labeler)) byLabeler.set(l.labeler, l.verdict);
      const v = [...byLabeler.values()];
      if (v.length >= 2) pairs.push([v[0]!, v[1]!]);
    }
  }
  if (pairs.length === 0) return { doubleLabeled: 0, observed: null, kappa: null };
  const n = pairs.length;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const k of GOLDEN_VERDICTS) {
    const a = pairs.filter(([x]) => x === k).length / n;
    const b = pairs.filter(([, y]) => y === k).length / n;
    pe += a * b;
  }
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { doubleLabeled: n, observed: round4(po), kappa: round4(kappa) };
}

// ---------------------------------------------------------------------------
// Metrics (task 2.1)
// ---------------------------------------------------------------------------

/** One judge answer. `entailment` is null when the judge call failed; a failed call
 *  counts as not passed and is reported in `errors`. */
export interface GoldenJudgement {
  id: string;
  expected: GoldenVerdict;
  entailment: number | null;
  passed: boolean;
}

export interface GoldenCounts {
  supportedPassed: number;
  supportedFailed: number;
  wrongPassed: number;
  wrongFailed: number;
  misgroundedPassed: number;
  misgroundedFailed: number;
  errors: number;
}

export interface GoldenMetrics {
  /** Of claims the judge passed, the share labeled supported. */
  precision: number | null;
  /** Of claims labeled supported, the share the judge passed. */
  recall: number | null;
  /** Of claims labeled misgrounded, the share the judge passed. */
  misgroundedRate: number | null;
  /** Of claims labeled wrong, the share the judge passed. */
  wrongPassRate: number | null;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const ratio = (num: number, den: number) => (den === 0 ? null : round4(num / den));

export function judgeItem(item: { id: string; expected: GoldenVerdict }, entailment: number | null, passThreshold: number): GoldenJudgement {
  return { id: item.id, expected: item.expected, entailment, passed: entailment !== null && entailment >= passThreshold };
}

export function countJudgements(js: readonly GoldenJudgement[]): GoldenCounts {
  const c: GoldenCounts = { supportedPassed: 0, supportedFailed: 0, wrongPassed: 0, wrongFailed: 0, misgroundedPassed: 0, misgroundedFailed: 0, errors: 0 };
  for (const j of js) {
    if (j.entailment === null) c.errors++;
    const key = `${j.expected}${j.passed ? "Passed" : "Failed"}` as keyof GoldenCounts;
    c[key]++;
  }
  return c;
}

export function computeMetrics(c: GoldenCounts): GoldenMetrics {
  const passed = c.supportedPassed + c.wrongPassed + c.misgroundedPassed;
  return {
    precision: ratio(c.supportedPassed, passed),
    recall: ratio(c.supportedPassed, c.supportedPassed + c.supportedFailed),
    misgroundedRate: ratio(c.misgroundedPassed, c.misgroundedPassed + c.misgroundedFailed),
    wrongPassRate: ratio(c.wrongPassed, c.wrongPassed + c.wrongFailed),
  };
}

// ---------------------------------------------------------------------------
// Config (thresholds, tolerance, pass threshold), from config/constants.md
// ---------------------------------------------------------------------------

export interface GoldenConfig {
  /** Entailment at or above this counts as a pass. */
  passThreshold: number;
  minPrecision: number;
  minRecall: number;
  maxMisgroundedRate: number;
  /** Largest absolute difference per metric a rerun may show and still match. */
  rerunTolerance: number;
}

export function goldenConfig(markdown?: string): GoldenConfig {
  const t = constantsTable(markdown);
  const num = (k: string) => {
    const raw = t.get(k);
    if (raw === undefined) throw new GoldenSetError(`"${k}" is missing from config/constants.md`);
    const n = Number(raw.replace(/\s/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new GoldenSetError(`"${k}" must be a number from 0 to 1 (got "${raw}")`);
    return n;
  };
  return {
    passThreshold: num("golden_pass_threshold"),
    minPrecision: num("golden_min_precision"),
    minRecall: num("golden_min_recall"),
    maxMisgroundedRate: num("golden_max_misgrounded_rate"),
    rerunTolerance: num("golden_rerun_tolerance"),
  };
}

// ---------------------------------------------------------------------------
// Result file (task 2.2)
// ---------------------------------------------------------------------------

const nullableRatio = z.number().min(0).max(1).nullable();

export const GoldenResultBodySchema = z.object({
  kind: z.literal(GOLDEN_RESULT_KIND),
  harnessVersion: z.string().min(1),
  /** ISO time the run finished. The page shows its date. */
  ranAt: z.string().datetime(),
  set: z.object({
    id: z.string(),
    version: z.string(),
    digest: z.string(),
    works: z.number().int(),
    claims: z.number().int(),
    /** The set's stage when the run was made. Absent on a result made before stages existed. */
    stage: z.enum(GOLDEN_STAGES).optional(),
  }),
  judge: z.object({
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    promptHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** The judge called through OpenRouter with the runner's own key. There is no public
     *  endpoint that scores claims (owner decision 2026-11-11). */
    backend: z.literal("openrouter"),
  }),
  passThreshold: z.number().min(0).max(1),
  /** The rerun tolerance this result was published under (Example until measured). */
  tolerance: z.number().min(0).max(1),
  metrics: z.object({ precision: nullableRatio, recall: nullableRatio, misgroundedRate: nullableRatio, wrongPassRate: nullableRatio }),
  counts: z.object({
    supportedPassed: z.number().int(),
    supportedFailed: z.number().int(),
    wrongPassed: z.number().int(),
    wrongFailed: z.number().int(),
    misgroundedPassed: z.number().int(),
    misgroundedFailed: z.number().int(),
    errors: z.number().int(),
  }),
  items: z.array(z.object({ id: z.string(), expected: z.enum(GOLDEN_VERDICTS), entailment: z.number().min(0).max(1).nullable(), passed: z.boolean() })),
});
export type GoldenResultBody = z.infer<typeof GoldenResultBodySchema>;

export const SignedGoldenResultSchema = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  body: GoldenResultBodySchema,
  signature: z.object({ keyId: z.string(), alg: z.literal("Ed25519"), value: z.string() }),
  /** Raw Ed25519 public key (base64url) or SPKI PEM of signature.keyId. Check the key
   *  id against /.well-known/report-keys to know it is ContextFile's. */
  publicKey: z.string().min(1),
});
export type SignedGoldenResult = z.infer<typeof SignedGoldenResultSchema>;

export function buildResultBody(input: {
  set: GoldenSet;
  judge: GoldenResultBody["judge"];
  judgements: GoldenJudgement[];
  passThreshold: number;
  tolerance: number;
  ranAt?: Date;
}): GoldenResultBody {
  const counts = countJudgements(input.judgements);
  const body: GoldenResultBody = {
    kind: GOLDEN_RESULT_KIND,
    harnessVersion: GOLDEN_HARNESS_VERSION,
    ranAt: (input.ranAt ?? new Date()).toISOString(),
    set: {
      id: input.set.manifest.id,
      version: input.set.manifest.version,
      digest: input.set.manifest.setDigest,
      works: input.set.works.length,
      claims: input.judgements.length,
      stage: input.set.manifest.stage,
    },
    judge: input.judge,
    passThreshold: input.passThreshold,
    tolerance: input.tolerance,
    metrics: computeMetrics(counts),
    counts,
    items: input.judgements.map((j) => ({ id: j.id, expected: j.expected, entailment: j.entailment === null ? null : round4(j.entailment), passed: j.passed })),
  };
  return GoldenResultBodySchema.parse(body);
}

export function digestResultBody(body: GoldenResultBody): string {
  return sha(canonicalize(body));
}

export function signResult(body: GoldenResultBody, signer: Signer & { publicKeyPem(): string }): SignedGoldenResult {
  const digest = digestResultBody(body);
  const signature: Signature = signer.sign(digest);
  return { digest, body, signature, publicKey: signer.publicKeyPem() };
}

export interface ResultCheck {
  digestValid: boolean;
  signatureValid: boolean;
  /** A stable published key (pem-...), not an ephemeral dev key. */
  stableKey: boolean;
  publishable: boolean;
}

export function checkResult(r: SignedGoldenResult): ResultCheck {
  const digestValid = digestResultBody(r.body) === r.digest;
  const signatureValid = verifySignature(r.digest, r.signature as Signature, r.publicKey);
  const stableKey = r.signature.keyId.startsWith("pem-");
  return { digestValid, signatureValid, stableKey, publishable: digestValid && signatureValid && stableKey };
}

export interface LoadedResult {
  file: string;
  result: SignedGoldenResult;
  check: ResultCheck;
}

/** Every result file, newest run first. Files that do not parse are reported, not dropped silently. */
export function loadResults(root: string = benchmarksRoot()): { results: LoadedResult[]; invalid: { file: string; reason: string }[] } {
  const dir = join(root, "results");
  const results: LoadedResult[] = [];
  const invalid: { file: string; reason: string }[] = [];
  if (!existsSync(dir)) return { results, invalid };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const result = SignedGoldenResultSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      results.push({ file: f, result, check: checkResult(result) });
    } catch (e) {
      invalid.push({ file: f, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  results.sort((a, b) => b.result.body.ranAt.localeCompare(a.result.body.ranAt));
  return { results, invalid };
}

// ---------------------------------------------------------------------------
// Rerun tolerance (task 2.3) and the judge gate (task 3.1)
// ---------------------------------------------------------------------------

const METRIC_NAMES = ["precision", "recall", "misgroundedRate", "wrongPassRate"] as const;

export interface RerunComparison {
  match: boolean;
  tolerance: number;
  diffs: { metric: (typeof METRIC_NAMES)[number]; published: number | null; rerun: number | null; diff: number | null; ok: boolean }[];
  problems: string[];
}

/** Compare an outside rerun against a published result, within the published tolerance. */
export function compareRuns(published: GoldenResultBody, rerun: GoldenResultBody): RerunComparison {
  const problems: string[] = [];
  if (published.set.digest !== rerun.set.digest) problems.push(`set digest differs (${published.set.digest} vs ${rerun.set.digest})`);
  if (published.judge.promptHash !== rerun.judge.promptHash) problems.push("judge prompt hash differs");
  if (published.judge.model !== rerun.judge.model) problems.push(`judge model differs (${published.judge.model} vs ${rerun.judge.model})`);
  const tol = published.tolerance;
  const diffs = METRIC_NAMES.map((metric) => {
    const a = published.metrics[metric];
    const b = rerun.metrics[metric];
    if (a === null || b === null) return { metric, published: a, rerun: b, diff: null, ok: a === b };
    const diff = round4(Math.abs(a - b));
    return { metric, published: a, rerun: b, diff, ok: diff <= tol + 1e-9 };
  });
  for (const d of diffs) if (!d.ok) problems.push(`${d.metric} differs by ${d.diff ?? "n/a"} (tolerance ${tol})`);
  return { match: problems.length === 0, tolerance: tol, diffs, problems };
}

export const JudgeGatePinSchema = z.object({
  /** The judge in place when the gate was introduced, before any golden run. It may
   *  stand without a result; any OTHER judge needs a passing result for its hash. */
  grandfathered: z.object({ version: z.string(), hash: z.string() }).nullable(),
});

export interface GateOutcome {
  ok: boolean;
  /** Plain reason, naming the metric that fell when one did. */
  reason: string;
  failedMetrics: string[];
}

/**
 * The judge change gate. The live judge passes when it is the grandfathered judge, or
 * when a publishable result for its exact prompt hash meets every threshold. A judge
 * change therefore cannot merge without a committed, passing, signed result.
 */
export function judgeGate(input: {
  live: { version: string; hash: string };
  pin: z.infer<typeof JudgeGatePinSchema>;
  results: readonly LoadedResult[];
  config: GoldenConfig;
}): GateOutcome {
  const { live, pin, config } = input;
  const forLive = input.results.filter((r) => r.result.body.judge.promptHash === live.hash && r.check.publishable);
  const latest = forLive[0];
  if (!latest) {
    if (pin.grandfathered && pin.grandfathered.hash === live.hash && pin.grandfathered.version === live.version) {
      return { ok: true, reason: `judge ${live.version} is the grandfathered judge; no golden run is required until it changes`, failedMetrics: [] };
    }
    return {
      ok: false,
      reason: `judge ${live.version} (${live.hash.slice(0, 15)}...) has no signed golden-set result. Run the harness with the new judge and commit the result to benchmarks/results/.`,
      failedMetrics: ["no result"],
    };
  }
  const m = latest.result.body.metrics;
  const failed: string[] = [];
  if (m.precision === null || m.precision < config.minPrecision) failed.push(`precision ${m.precision ?? "n/a"} is below ${config.minPrecision}`);
  if (m.recall === null || m.recall < config.minRecall) failed.push(`recall ${m.recall ?? "n/a"} is below ${config.minRecall}`);
  if (m.misgroundedRate === null || m.misgroundedRate > config.maxMisgroundedRate) {
    failed.push(`misgrounded rate ${m.misgroundedRate ?? "n/a"} is above ${config.maxMisgroundedRate}`);
  }
  if (failed.length) return { ok: false, reason: `judge ${live.version} fails the golden set (${latest.file}): ${failed.join("; ")}`, failedMetrics: failed };
  return { ok: true, reason: `judge ${live.version} meets every threshold (${latest.file})`, failedMetrics: [] };
}

export function loadJudgeGatePin(root: string = benchmarksRoot()): z.infer<typeof JudgeGatePinSchema> {
  return JudgeGatePinSchema.parse(JSON.parse(readFileSync(join(root, "judge-gate.json"), "utf8")));
}
