// Judge versioning (Report Invariant 5). The verify stage scores each claim's
// entailment against its cited passage. Every report pins the judge model id and the
// prompt-version HASH. The live prompt text is public (owner decision 2026-11-11): it
// is exported here and published in benchmarks/judge-prompt.json, served at
// /benchmarks/judge-prompt.json, so an outsider can rerun the golden-set benchmark with
// the exact prompt the hash pins. A test fails when that file drifts from this module.
// When vN+1 ships, vN's text also moves to the retired-prompt archive.

import { createHash } from "node:crypto";

export const JUDGE_PROMPT_VERSION = "v0-dev";

// The live template. Its exact bytes are hashed and pinned; change one character and
// the version, the hash and the published file must all move together.
const JUDGE_TEMPLATE = `You are a strict entailment verifier. Given a CLAIM and a
SOURCE PASSAGE, decide whether the passage SUPPORTS the claim — not merely mentions
the topic. Score entailment from 0.0 (contradicted or unsupported) to 1.0 (fully
entailed). Reply with a single JSON object:
{"entailment": <number 0..1>, "supported": <boolean>, "reason": "<short>"}
Do not credit hedged, speculative, or topic-adjacent statements.`;

/** The exact live judge prompt text, the bytes judgePromptHash() covers. */
export function judgePromptText(): string {
  return JUDGE_TEMPLATE;
}

/** The published form of the live judge: benchmarks/judge-prompt.json and its URL. */
export interface PublishedJudgePrompt {
  kind: "contextfile.judge-prompt/v1";
  version: string;
  hash: string;
  text: string;
}

export const JUDGE_PROMPT_FILE = "judge-prompt.json";
export const JUDGE_PROMPT_URL = "/benchmarks/judge-prompt.json";

export function publishedJudgePrompt(): PublishedJudgePrompt {
  return { kind: "contextfile.judge-prompt/v1", version: JUDGE_PROMPT_VERSION, hash: judgePromptHash(), text: JUDGE_TEMPLATE };
}

/** The file's exact bytes: stable two-space JSON with a trailing newline. */
export function judgePromptFileText(): string {
  return JSON.stringify(publishedJudgePrompt(), null, 2) + "\n";
}

export function judgePromptHash(): string {
  return "sha256:" + createHash("sha256").update(JUDGE_TEMPLATE).digest("hex");
}

/** Build the per-claim verification message pair for the model call. */
export function buildJudgeMessages(claim: string, sourcePassage: string) {
  return [
    { role: "system" as const, content: JUDGE_TEMPLATE },
    {
      role: "user" as const,
      content: `CLAIM:\n${claim}\n\nSOURCE PASSAGE:\n${sourcePassage}`,
    },
  ];
}

export interface JudgePin {
  model: string;
  promptVersion: string;
  promptHash: string;
}

export function judgePin(model: string): JudgePin {
  return { model, promptVersion: JUDGE_PROMPT_VERSION, promptHash: judgePromptHash() };
}
