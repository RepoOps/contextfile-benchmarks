// The harness constants for the public benchmarks repo. In the ContextFile monorepo
// these numbers live in an audited config table; this repo carries only the rows the
// harness reads, in config/constants.md, written by scripts/publish-benchmarks.mjs.
//
// Same reader as the monorepo: the first cell of each `| name | value | ... |` row is
// the key and the second is the raw value. It fails closed: a missing file throws.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export class ConstantsError extends Error {
  readonly code = "policy_constants_unavailable";
  constructor(message: string) {
    super(`[contextfile] constants: ${message}`);
    this.name = "ConstantsError";
  }
}

/** packages/core/src -> repo root, then the cwd, as the monorepo reader does. */
function constantsPath(): string {
  const rel = ["config", "constants.md"];
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", "..", "..", ...rel), resolve(process.cwd(), ...rel)];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

function parseTable(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    const [rawKey, rawValue] = cells;
    if (!rawKey || rawValue === undefined) continue;
    if (rawKey === "Constant" || /^-+$/.test(rawKey)) continue;
    const key = rawKey.replace(/`/g, "").trim();
    if (key) out.set(key, rawValue.replace(/`/g, "").trim());
  }
  return out;
}

/** Every row of config/constants.md as raw strings. */
export function constantsTable(markdown?: string): Map<string, string> {
  if (markdown !== undefined) return parseTable(markdown);
  const path = constantsPath();
  try {
    return parseTable(readFileSync(path, "utf8"));
  } catch {
    throw new ConstantsError(`cannot read ${path}. The constants file must exist.`);
  }
}
