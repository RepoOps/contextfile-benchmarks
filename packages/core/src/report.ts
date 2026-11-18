// The Verification Report — the unit of proof. One universal schema for EVERY
// artifact type (Report Invariant 2): for prose, claims are entailment-scored
// statements; for oci_image, claims are provenance attestations in the same shape;
// for wiki_diary, claims bind entries to commits. Content-addressed (digest = hash
// of the canonical body) and signed (Report Invariant 4).

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildSigner, verifySignature, type Signature, type Signer } from "./signing.ts";

export const ClaimStateSchema = z.enum(["verified", "in_review", "cut"]);

export const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  sourceId: z.string(),
  locator: z.string(),
  entailment: z.number().min(0).max(1),
  state: ClaimStateSchema,
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

/** The scope block for a run, from the stages it entered (the run record) and the
 *  judge pin it used. A check whose stage did not run is listed as not run. `limits`
 *  (a skill scan's, R11) are added to what the report does not cover. */
export function scopeForRun(run: { stages: readonly string[]; judgeVersion: string; scanners?: { name: string; version: string }[]; limits?: readonly string[] }): ReportScope {
  const ran = new Set(run.stages.map((s) => STAGE_CHECKS[s]).filter((c): c is PipelineCheck => c !== undefined));
  const all = Object.keys(PIPELINE_CHECKS) as PipelineCheck[];
  return {
    checks_run: all.filter((c) => ran.has(c)),
    checks_not_run: all.filter((c) => !ran.has(c)),
    not_covered: [...PIPELINE_NOT_COVERED, ...(run.limits ?? [])],
    judge_version: run.judgeVersion,
    scanners: [...(run.scanners ?? [])],
  };
}
