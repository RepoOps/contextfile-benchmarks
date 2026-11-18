// Offline check of everything this repo publishes. No key, no network, no model call.
//
//   node --experimental-strip-types verify.ts
//
// It checks that the golden set, the uplift task set and their manifests agree digest
// for digest; that benchmarks/judge-prompt.json is the prompt in judge.ts; that every
// signed result's digest matches its body, its signature verifies under the public key
// it carries and its key id is the hash of that key; that the judge gate passes; and
// that every tool selection and session-start result's digest matches its body and its
// metrics follow from its outcomes. Exit code 1 names each failure.
import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runGoldenCli } from "./packages/core/src/golden-cli.ts";
import { benchmarksRoot, loadGoldenSet, loadResults } from "./packages/core/src/golden-set.ts";
import { judgePromptHash } from "./packages/core/src/judge.ts";
import { ed25519PublicKey, keyIdForPublicKey } from "./packages/core/src/signing.ts";
import { runUpliftCli } from "./packages/core/src/uplift-cli.ts";
import { loadUpliftResults, loadUpliftSet } from "./packages/core/src/uplift.ts";
import { digestOf, scoreSelection, selectionRoot, SelectionResultSchema } from "./packages/mcp/src/selection-eval.ts";
import { loadEvalInputs } from "./packages/mcp/src/selection-eval-cli.ts";
import { scoreSession, SessionResultSchema, sessionStartRoot } from "./packages/mcp/src/session-start-eval.ts";
import { loadSessionInputs } from "./packages/mcp/src/session-start-eval-cli.ts";

const failures: string[] = [];
const say = (s: string) => process.stdout.write(s + "\n");
const fail = (s: string) => {
  failures.push(s);
  say(`FAIL ${s}`);
};

async function step(name: string, fn: () => Promise<string | void> | string | void) {
  try {
    const out = await fn();
    say(`ok   ${name}${out ? `: ${out.replace(/\n/g, "\n       ")}` : ""}`);
  } catch (e) {
    fail(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The key id is "pem-" plus 16 hex of the SPKI hash of the public key the file carries. */
function keyIdMatches(keyId: string, publicKey: string): boolean {
  try {
    return keyIdForPublicKey(ed25519PublicKey(publicKey)) === keyId;
  } catch {
    return false;
  }
}

const root = benchmarksRoot();
const selection = selectionRoot(root);

await step("golden set manifest is current", () => runGoldenCli(["manifest"]));
await step("golden set loads", () => runGoldenCli(["check"]));
await step("judge-prompt.json matches judge.ts", () => runGoldenCli(["judge-prompt"]));

const golden = loadGoldenSet(root);
const goldenResults = loadResults(root);
for (const bad of goldenResults.invalid) fail(`benchmarks/results/${bad.file} does not parse: ${bad.reason}`);
for (const r of goldenResults.results) {
  const b = r.result.body;
  const problems: string[] = [];
  if (!r.check.digestValid) problems.push("digest does not match body");
  if (!r.check.signatureValid) problems.push("signature does not verify");
  if (!r.check.stableKey) problems.push(`key ${r.result.signature.keyId} is not a stable published key`);
  if (!keyIdMatches(r.result.signature.keyId, r.result.publicKey)) problems.push("key id is not the hash of the public key");
  if (problems.length) {
    fail(`benchmarks/results/${r.file}: ${problems.join("; ")}`);
    continue;
  }
  const notes = [
    b.set.digest === golden.manifest.setDigest ? "current set" : "an earlier set",
    b.judge.promptHash === judgePromptHash() ? "live judge prompt" : "an earlier judge prompt",
  ];
  say(`ok   benchmarks/results/${r.file}: ${b.judge.model}, signed by ${r.result.signature.keyId}, ${notes.join(", ")}; precision ${b.metrics.precision} recall ${b.metrics.recall} misgrounded ${b.metrics.misgroundedRate}`);
}
await step("judge gate", () => runGoldenCli(["gate"]));

await step("uplift manifest is current", () => runUpliftCli(["manifest"]));
await step("uplift task set and run config load", () => runUpliftCli(["check"]));
const uplift = loadUpliftSet();
const upliftResults = loadUpliftResults();
for (const bad of upliftResults.invalid) fail(`benchmarks/uplift/results/${bad.file} does not parse: ${bad.reason}`);
for (const r of upliftResults.results) {
  const problems: string[] = [];
  if (!r.check.digestValid) problems.push("digest does not match body");
  if (!r.check.signatureValid) problems.push("signature does not verify");
  if (!r.check.stableKey) problems.push(`key ${r.result.signature.keyId} is not a stable published key`);
  if (!keyIdMatches(r.result.signature.keyId, r.result.publicKey)) problems.push("key id is not the hash of the public key");
  if (problems.length) fail(`benchmarks/uplift/results/${r.file}: ${problems.join("; ")}`);
  else say(`ok   benchmarks/uplift/results/${r.file}: signed by ${r.result.signature.keyId}, ${r.result.body.set.digest === uplift.manifest.setDigest ? "current" : "an earlier"} task set`);
}
if (upliftResults.results.length === 0) say("note no uplift result is published yet");

/** Digest and metrics of every unsigned eval result in a folder. */
function checkUnsigned<T extends { digest: string; body: { metrics: Record<string, unknown> } }>(
  dir: string,
  label: string,
  parse: (v: unknown) => T,
  score: (r: T) => Record<string, unknown>,
  notes: (r: T) => string
) {
  if (!existsSync(dir)) {
    say(`note no ${label} result is published yet`);
    return;
  }
  const files = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  if (files.length === 0) say(`note no ${label} result is published yet`);
  for (const f of files) {
    const rel = `${label}/${f}`;
    let r: T;
    try {
      r = parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch (e) {
      fail(`${rel} does not parse: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      continue;
    }
    if (digestOf(r.body) !== r.digest) {
      fail(`${rel}: digest does not match body`);
      continue;
    }
    // Keep only the metric keys the file carries: results made before a metric existed leave it out.
    const recomputed = score(r);
    const kept = Object.fromEntries(Object.keys(r.body.metrics).map((k) => [k, recomputed[k]]));
    try {
      deepStrictEqual(kept, r.body.metrics);
    } catch {
      fail(`${rel}: metrics do not follow from the outcomes`);
      continue;
    }
    say(`ok   ${rel}: ${notes(r)}`);
  }
}

await step("tool selection tasks and competitors load", () => {
  const i = loadEvalInputs(selection);
  return `${i.tasks.tasks.length} tasks, ${i.runnable.length} runnable, ${i.competitors.servers.length} competing servers`;
});
const selInputs = loadEvalInputs(selection);
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const tasksDigest = sha(selInputs.tasksText);
const competitorsDigest = sha(selInputs.competitorsText);
checkUnsigned(
  join(selection, "results"),
  "benchmarks/tool-selection/results",
  (v) => SelectionResultSchema.parse(v),
  (r) => scoreSelection(r.body.outcomes) as unknown as Record<string, unknown>,
  (r) => `${r.body.model}, ${r.body.tasksDigest === tasksDigest ? "current" : "earlier"} tasks.json, ${r.body.competitorsDigest === competitorsDigest ? "current" : "earlier"} competitors.json`
);

await step("session-start scenario loads", () => {
  const i = loadSessionInputs(selection);
  return `${i.scenario.tasks.length} tasks, instructions block of ${i.instructions.length} characters`;
});
checkUnsigned(
  join(sessionStartRoot(selection), "results"),
  "benchmarks/tool-selection/session-start/results",
  (v) => SessionResultSchema.parse(v),
  (r) => scoreSession(r.body.outcomes) as unknown as Record<string, unknown>,
  (r) => r.body.model
);

say(failures.length ? `\n${failures.length} check(s) failed.` : "\nEvery check passed.");
process.exitCode = failures.length ? 1 : 0;
