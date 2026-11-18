// The OpenRouter client for the public benchmarks repo: the part of ContextFile's
// packages/core/src/openrouter.ts the golden-set judge uses. It sends the same request
// body and headers as the monorepo client (scripts/publish-benchmarks.mjs --check
// compares the two), with the runner's own OPENROUTER_API_KEY. Plain fetch, no SDK.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; costUsd: number | null };
  raw: unknown;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the model to return a JSON object. */
  json?: boolean;
  signal?: AbortSignal;
  /** Test seam for the HTTP call. */
  fetchImpl?: typeof fetch;
}

export class OpenRouterError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retryable = retryable;
  }
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new OpenRouterError("OPENROUTER_API_KEY is not set; the judge cannot call models.", undefined, false);
  return key;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    usage: { include: true },
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: "json_object" };

  // Read before the request so a missing key fails closed, not as a retryable network error.
  const key = apiKey();
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://contextfile.ai",
        "X-Title": "ContextFile",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new OpenRouterError(`network error calling OpenRouter: ${(e as Error).message}`, undefined, true);
  }

  if (!res.ok) {
    // A refused key's answer can quote part of the key, so 401 and 403 keep no body.
    const text = res.status === 401 || res.status === 403 ? "the key was refused" : await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    throw new OpenRouterError(`OpenRouter ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
  }

  const data = (await res.json()) as any;
  const usage = data?.usage ?? {};
  return {
    text: data?.choices?.[0]?.message?.content ?? "",
    model: data?.model ?? opts.model,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: typeof usage.cost === "number" ? usage.cost : null,
    },
    raw: data,
  };
}

/** Parse a model's JSON reply defensively (models sometimes wrap JSON in prose). */
export function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const startArr = trimmed.indexOf("[");
  const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  const candidate = from === -1 ? trimmed : trimmed.slice(from);
  return JSON.parse(candidate) as T;
}
