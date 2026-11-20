// The Verification Report — the unit of proof. One universal schema for EVERY
// artifact type (Report Invariant 2): for prose, claims are entailment-scored
// statements; for oci_image, claims are provenance attestations in the same shape;
// for wiki_diary, claims bind entries to commits. Content-addressed (digest = hash
// of the canonical body) and signed (Report Invariant 4).

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildSigner, verifySignature, type Signature, type Signer } from "./signing.ts";

export const ClaimStateSchema = z.enum(["verified", "in_review", "cut"]);

// Roadmap item 3: how a claim was decided. `judge` is the pinned model judge; the
// executed checks (executed-checks.ts) are `api_surface` (every named symbol looked up
// in the API surface of the locked sources), `typecheck` (TypeScript compiler) and
// `syntax_check` (Python parser); `executed` (core-3) means a run of the example in the
// container sandbox decided it; `none` means there was no source to check against.
// Optional, like `check`, so reports signed before them still parse and keep their digest.
export const ClaimMethodSchema = z.enum(["judge", "api_surface", "typecheck", "syntax_check", "executed", "none"]);

/** An example run's outcome (example-runner.ts). Absent before core-3 and when the
 *  example was not sent to the runner. */
export const ExampleRunSchema = z.object({
  outcome: z.enum(["passed", "failed", "needs_network", "timed_out", "not_run"]),
  runner: z.string().optional(),
  exitCode: z.number().int().optional(),
  detail: z.string().optional(),
});

/** What an executed check found for one claim. */
export const ClaimCheckSchema = z.object({
  symbols: z.array(z.object({ name: z.string(), found: z.boolean(), signature: z.string().optional(), sourceId: z.string().optional() })).optional(),
  snippets: z.array(z.object({ language: z.string(), tool: z.string(), ok: z.boolean(), diagnostics: z.array(z.string()), run: ExampleRunSchema.optional() })).optional(),
});

export const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  sourceId: z.string(),
  locator: z.string(),
  entailment: z.number().min(0).max(1),
  state: ClaimStateSchema,
  method: ClaimMethodSchema.optional(),
  check: ClaimCheckSchema.optional(),
  // Roadmap item 8: the id of the artifact section the claim came from (sections.ts
  // splitSections), so a refresh keeps the claims of the sections it did not touch.
  section: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// R7 scope statement: what this report checked and what it does not cover. Built by
// scopeForRun from the stages the pipeline run entered, never typed by hand. Optional
// so reports signed before R7 still parse and keep their digest.
export const ScopeSchema = z.object({
  checks_run: z.array(z.string()),
  checks_not_run: z.array(z.string()),
  not_covered: z.array(z.string()),
  judge_version: z.string(),
  scanners: z.array(z.object({ name: z.string(), version: z.string() })),
});
export type ReportScope = z.infer<typeof ScopeSchema>;

// Roadmap item 9: rights data per locked source. `spdx` is the license the source was
// registered under (licenseVerdict checked it before the fetch), `url` where the bytes
// came from, `commit` the upstream commit for a git source, `retrievedAt` when the
// bytes were fetched. A field the corpus does not know is left out, never guessed.
export const SourceRightsSchema = z.object({
  sourceId: z.string(),
  locator: z.string(),
  digest: z.string(),
  spdx: z.string().optional(),
  url: z.string().optional(),
  commit: z.string().optional(),
  retrievedAt: z.string().optional(),
});
export type SourceRights = z.infer<typeof SourceRightsSchema>;

// The judge's agreement with the labeled golden set, read from a signed result in
// benchmarks/results for the same judge model and prompt hash. Kappa is Cohen's kappa
// between the judge's pass and the human label "supported". Never typed by hand.
export const JudgeCalibrationSchema = z.object({
  goldenSet: z.object({ id: z.string(), version: z.string(), digest: z.string(), stage: z.string().optional() }),
  resultDigest: z.string(),
  ranAt: z.string(),
  claims: z.number().int(),
  kappa: z.number().nullable(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  wrongPassRate: z.number().nullable(),
  misgroundedRate: z.number().nullable(),
});
export type JudgeCalibration = z.infer<typeof JudgeCalibrationSchema>;

// The API surface the executed checks looked symbols up in: its digest, size and sources.
export const ApiSurfaceSummarySchema = z.object({
  digest: z.string(),
  symbols: z.number().int(),
  sourceIds: z.array(z.string()),
});

// Roadmap item 2: sections of the generated text the generic-section post-check flagged
// (knowledge-gap.ts genericSections). The text is not edited; the report says so.
export const GenericSectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  reason: z.enum(["overview_heading", "no_specifics"]),
});

// Roadmap item 8: a version built by refreshing only the sections an upstream release
// touched. `base` is the version it was refreshed from; each section says whether it was
// regenerated (and which changed symbols or sources made it stale) or kept with its
// claims and results. `semver` follows the API diff: removed or changed symbol major,
// added minor, docs only patch.
export const RefreshSchema = z.object({
  base: z.object({ reportDigest: z.string(), artifactDigest: z.string(), semver: z.string().optional() }),
  semver: z.string(),
  bump: z.enum(["major", "minor", "patch", "none"]),
  apiDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }),
  apiSurfaces: z.object({ base: z.string(), next: z.string() }),
  changelogLines: z.number().int(),
  sections: z.array(
    z.object({
      id: z.string(),
      heading: z.string(),
      status: z.enum(["regenerated", "kept", "added"]),
      symbols: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
    })
  ),
});
export type ReportRefresh = z.infer<typeof RefreshSchema>;

// The report BODY is what gets hashed + signed. The digest and signature wrap it.
export const ReportBodySchema = z.object({
  artifact: z.object({
    digest: z.string(),
    type: z.string(),
    version: z.number().int(),
  }),
  pipeline: z.object({
    version: z.string(),
    modelRouting: z.array(z.string()),
    corpusLockHash: z.string(),
  }),
  claims: z.array(ClaimSchema),
  summary: z.object({
    claimsTotal: z.number().int(),
    verified: z.number().int(),
    floor: z.number().min(0).max(1),
    meanEntailment: z.number().min(0).max(1).nullable(),
    humanReviewed: z.boolean(),
  }),
  // Judge pinned by id + prompt-version hash (Report Invariant 5). The live prompt
  // template is NOT stored — only its hash.
  judge: z.object({
    model: z.string(),
    promptVersion: z.string(),
    promptHash: z.string(),
  }),
  scope: ScopeSchema.optional(),
  // All three optional, added with pipeline core-1: reports signed before still verify.
  sources: z.array(SourceRightsSchema).optional(),
  judgeCalibration: JudgeCalibrationSchema.optional(),
  apiSurface: ApiSurfaceSummarySchema.optional(),
  // Optional, added with pipeline core-2.
  genericSections: z.array(GenericSectionSchema).optional(),
  refresh: RefreshSchema.optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

export const SignatureSchema = z.object({
  keyId: z.string(),
  alg: z.literal("Ed25519"),
  value: z.string(),
});

export const SignedReportSchema = z.object({
  digest: z.string(),
  body: ReportBodySchema,
  signature: SignatureSchema,
});
export type SignedReport = z.infer<typeof SignedReportSchema>;

// Deterministic canonicalization: JSON with object keys sorted recursively, so the
// same logical report always hashes to the same digest regardless of key order.
export function canonicalize(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("cannot canonicalize a cyclic value");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

/** Content-address a report body: sha256 of its canonical form. */
export function digestReportBody(body: ReportBody): string {
  return "sha256:" + createHash("sha256").update(canonicalize(body)).digest("hex");
}

/** Build a signed, content-addressed report from a validated body. The signer
 *  defaults to the environment's (KMS in prod, dev key otherwise); tests pass a
 *  known signer so the signature can be verified against its public key. */
export function signReport(body: ReportBody, signer: Signer = buildSigner()): SignedReport {
  ReportBodySchema.parse(body);
  const digest = digestReportBody(body);
  const signature = signer.sign(digest);
  return { digest, body, signature };
}

/** Verify a report end-to-end: (1) the digest matches the body (nothing altered),
 *  and (2) the signature verifies against the published public key. Pure. */
export function verifyReport(report: SignedReport, publicKey: string): {
  digestValid: boolean;
  signatureValid: boolean;
} {
  const recomputed = digestReportBody(report.body);
  const digestValid = recomputed === report.digest;
  const signatureValid = verifySignature(report.digest, report.signature as Signature, publicKey);
  return { digestValid, signatureValid };
}

/** Summaries are computed from claims, never typed by hand (Ground Rule 7). */
export function summarize(claims: Claim[], floor: number, humanReviewed = false): ReportBody["summary"] {
  const verified = claims.filter((c) => c.state === "verified").length;
  const scored = claims.filter((c) => Number.isFinite(c.entailment));
  const meanEntailment =
    scored.length === 0 ? null : scored.reduce((a, c) => a + c.entailment, 0) / scored.length;
  return { claimsTotal: claims.length, verified, floor, meanEntailment, humanReviewed };
}

/** The checks a pipeline run can perform, by id, in run order. */
export const PIPELINE_CHECKS = {
  corpus_lock: "Sources were locked and hashed before any claim was scored",
  claim_decomposition: "The text was split into atomic factual claims",
  claim_entailment: "Each claim was scored against the source it cites by the pinned judge",
  floor_binding: "Each claim was bound to verified, in review or cut at the floor",
  humanize_reverify: "Claims were re-verified after the style pass",
  api_surface: "Every symbol a code claim names was looked up in the API surface extracted from the locked sources",
  snippet_typecheck: "TypeScript and JavaScript snippets were type-checked in a sandbox with a time limit",
  snippet_syntax: "Python snippets were parsed at the pinned language version in a sandbox with a time limit",
  example_run: "Code examples whose checks passed were run in a container with no network, a read-only file system, no added privileges and memory, process and time limits",
  output_injection_scan: "The generated text was scanned for hidden text and injected instructions before the run completed",
  source_rights: "Each source's license (SPDX id), origin URL and upstream commit or retrieval date were recorded",
  version_diff: "The changes between the versions in the locked sources (changelog, API diff, deprecations) were computed without a model and given to the generate stage",
  generic_section_scan: "The generated text was checked for generic overview sections, and any found are named in the report",
  section_refresh: "Only the sections that mention a changed symbol or cite a changed source were regenerated and re-verified; the others kept their claims and results",
  kept_section_recheck: "The kept sections' symbols and code were checked again against the new release's sources, without a model",
} as const;
export type PipelineCheck = keyof typeof PIPELINE_CHECKS;

/** What no pipeline run covers. Fixed per pipeline, so it is code, not run data. */
export const PIPELINE_NOT_COVERED = [
  "Whether the cited sources are themselves true",
  "Factual statements the decomposition step did not extract as claims",
  "Safety or security of code, commands or instructions in the artifact",
  "Licensing or ownership of the artifact content",
] as const;

/** Which check each pipeline stage performs. Stages with no check (generate) map to none. */
const STAGE_CHECKS: Record<string, PipelineCheck | undefined> = {
  retrieve: "corpus_lock",
  decompose: "claim_decomposition",
  verify: "claim_entailment",
  bind: "floor_binding",
  humanize: "humanize_reverify",
};

/** The scope block for a run, from the stages it entered (the run record), the checks
 *  outside a stage that ran (`checks`: executed checks, the output scan) and the
 *  judge pin it used. A check whose stage did not run is listed as not run. `limits`
 *  (a skill scan's, R11) are added to what the report does not cover. */
export function scopeForRun(run: { stages: readonly string[]; judgeVersion: string; scanners?: { name: string; version: string }[]; limits?: readonly string[]; checks?: readonly PipelineCheck[] }): ReportScope {
  const ran = new Set([...run.stages.map((s) => STAGE_CHECKS[s]).filter((c): c is PipelineCheck => c !== undefined), ...(run.checks ?? [])]);
  const all = Object.keys(PIPELINE_CHECKS) as PipelineCheck[];
  return {
    checks_run: all.filter((c) => ran.has(c)),
    checks_not_run: all.filter((c) => !ran.has(c)),
    not_covered: [...PIPELINE_NOT_COVERED, ...(run.limits ?? [])],
    judge_version: run.judgeVersion,
    scanners: [...(run.scanners ?? [])],
  };
}
