/**
 * AI router: the single gateway for every LLM call in NextCRM.
 *
 * Mirrors the fallback design of team_airfp_2's ai-router.ts:
 * - an ordered provider chain (only providers with a configured key), with
 *   rate-limited providers pushed to the end of the chain while cooling down;
 * - several models per provider and per tier (light / normal / thinking),
 *   tried in order before moving to the next provider;
 * - error classification per attempt (auth, rate limit, model not found,
 *   timeout, empty / truncated / invalid-JSON response) deciding whether to
 *   try the next model or skip the provider;
 * - a per-procedure breaker: after repeated complete failures a procedure is
 *   blocked for a cooldown instead of hammering every provider;
 * - step-by-step console tracing keyed by a requestId.
 *
 * Every provider is reached through its OpenAI-compatible chat.completions
 * endpoint, so tool calling and message history work across fallbacks. The one
 * exception is web search (`webSearch: true`): Gemini grounds with Google
 * Search through its native generateContent API, OpenRouter through its web
 * plugin; providers without search are left out of the chain.
 */
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { randomUUID } from "crypto";
import { getApiKey, type ApiKeyProvider } from "@/lib/api-keys";

export type AIProvider = Extract<ApiKeyProvider, "OPENAI" | "GEMINI" | "OPENROUTER" | "ANTHROPIC">;
export type ModelTier = "light" | "normal" | "thinking";

export const DEFAULT_PROVIDER_ORDER: AIProvider[] = ["OPENAI", "GEMINI", "OPENROUTER", "ANTHROPIC"];

const PROVIDERS: Record<
  AIProvider,
  { baseURL?: string; models: Record<ModelTier, string[]>; nativeJsonMode: boolean }
> = {
  OPENAI: {
    models: {
      light: ["gpt-4o-mini", "gpt-5-mini"],
      normal: ["gpt-5-mini", "gpt-4o-mini"],
      thinking: ["gpt-5", "gpt-5-mini"],
    },
    nativeJsonMode: true,
  },
  GEMINI: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    models: {
      light: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
      normal: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
      thinking: ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    nativeJsonMode: true,
  },
  OPENROUTER: {
    baseURL: "https://openrouter.ai/api/v1",
    models: {
      light: ["openai/gpt-4o-mini", "google/gemini-2.5-flash-lite"],
      normal: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
      thinking: ["anthropic/claude-sonnet-4.6", "openai/gpt-5"],
    },
    nativeJsonMode: true,
  },
  ANTHROPIC: {
    baseURL: "https://api.anthropic.com/v1/",
    models: {
      light: ["claude-haiku-4-5"],
      normal: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      thinking: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    },
    // The Anthropic compatibility layer ignores response_format: JSON is
    // requested in the system prompt instead.
    nativeJsonMode: false,
  },
};

/** Providers that can ground a reply with live web search results. */
const WEB_SEARCH_PROVIDERS: AIProvider[] = ["GEMINI", "OPENROUTER"];
const GEMINI_NATIVE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_WEB_RESULTS = 5;

const DEFAULT_TIMEOUT_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_PROCEDURE_FAILURES = 3;
const PROCEDURE_COOLDOWN_MS = 10 * 60 * 1000;

export type RouterChatParams = Omit<ChatCompletionCreateParamsNonStreaming, "model"> & {
  tier?: ModelTier;
  timeoutMs?: number;
  /** Ground the reply with live web search (Gemini / OpenRouter only, no tools). */
  webSearch?: boolean;
  /** Internal: JSON was asked for in the prompt instead of response_format. */
  jsonInPrompt?: boolean;
};

export interface WebSource {
  title?: string;
  url: string;
}

export interface AIGenerationConfig {
  tier?: ModelTier;
  responseFormat?: "text" | "json";
  /** JSON Schema for structured output (implies responseFormat "json"). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  webSearch?: boolean;
}

export interface AIGenerationContext {
  userId?: string;
  /** Calling feature, e.g. "crm.targets.suggestMapping". Keys the breaker and the logs. */
  procedure: string;
  /** Groups the calls of one workflow (e.g. one enrichment run). */
  correlationId?: string;
}

export interface AIChatResult {
  completion: ChatCompletion;
  message: ChatCompletionMessage;
  /** Message text; for JSON requests, the extracted and re-serialised JSON. */
  text: string;
  provider: AIProvider;
  modelUsed: string;
  requestId: string;
  attempts: number;
  /** Web pages the reply was grounded on (webSearch requests). */
  sources: WebSource[];
}

export type AIGenerationResult = Omit<AIChatResult, "completion" | "message"> & {
  usage?: ChatCompletion["usage"];
};

export type AIRouterErrorCode = "NO_PROVIDER" | "ALL_PROVIDERS_FAILED" | "PROCEDURE_BLOCKED";

export class AIRouterError extends Error {
  constructor(
    public code: AIRouterErrorCode,
    message: string,
    public failures: Array<{ provider: AIProvider; model: string; error: string }> = []
  ) {
    super(message);
    this.name = "AIRouterError";
  }
}

type FailureKind =
  | "auth"
  | "rate_limit"
  | "model_not_found"
  | "bad_request"
  | "timeout"
  | "server"
  | "empty_response"
  | "truncated"
  | "invalid_json"
  | "unknown";

class AttemptError extends Error {
  constructor(public kind: FailureKind, message: string, public retryAfterMs?: number) {
    super(message);
  }
}

export function classifyError(error: unknown): AttemptError {
  if (error instanceof AttemptError) return error;
  const err = error as { status?: number; message?: string; name?: string; headers?: unknown };
  const message = err?.message ?? String(error);
  const status = typeof err?.status === "number" ? err.status : undefined;

  if (status === 401 || status === 403) return new AttemptError("auth", message);
  if (status === 429) {
    let retryAfterMs: number | undefined;
    const headers = err.headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
    const raw =
      typeof (headers as { get?: unknown })?.get === "function"
        ? (headers as { get: (k: string) => string | null }).get("retry-after")
        : (headers as Record<string, string> | undefined)?.["retry-after"];
    const seconds = raw ? Number(raw) : NaN;
    if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    return new AttemptError("rate_limit", message, retryAfterMs);
  }
  if (status === 404) return new AttemptError("model_not_found", message);
  if (status === 400 || status === 422) return new AttemptError("bad_request", message);
  if (status !== undefined && status >= 500) return new AttemptError("server", message);
  if (/timeout|timed out|aborted|DEADLINE_EXCEEDED/i.test(`${err?.name} ${message}`)) {
    return new AttemptError("timeout", message);
  }
  return new AttemptError("unknown", message);
}

/** Extract a JSON value from a model reply (markdown fences, prose around it). */
export function extractJson(text: string): unknown | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to substring extraction
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = unfenced.indexOf(open);
    const end = unfenced.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // try the next shape
      }
    }
  }
  return undefined;
}

function wantsJson(params: RouterChatParams): { json: boolean; schema?: unknown } {
  const rf = params.response_format as
    | { type: "json_object" }
    | { type: "json_schema"; json_schema?: { schema?: unknown } }
    | { type: "text" }
    | undefined;
  if (!rf || rf.type === "text") return { json: !!params.jsonInPrompt };
  return { json: true, schema: rf.type === "json_schema" ? rf.json_schema?.schema : undefined };
}

/** Same request without response_format, asking for JSON in the system prompt instead. */
function withPromptedJson(params: RouterChatParams): RouterChatParams {
  const { schema } = wantsJson(params);
  const instruction =
    "Respond with a single valid JSON value only — no markdown, no prose." +
    (schema ? ` It must match this JSON Schema:\n${JSON.stringify(schema)}` : "");
  const messages = [...params.messages];
  const systemIndex = messages.findIndex((m) => m.role === "system");
  if (systemIndex >= 0) {
    const system = messages[systemIndex];
    messages[systemIndex] = {
      ...system,
      content: `${typeof system.content === "string" ? system.content : ""}\n\n${instruction}`,
    } as ChatCompletionMessageParam;
  } else {
    messages.unshift({ role: "system", content: instruction });
  }
  const { response_format: _dropped, ...rest } = params;
  return { ...rest, messages, jsonInPrompt: true };
}

/** Provider-specific parameter normalisation. */
function buildRequest(
  provider: AIProvider,
  model: string,
  params: RouterChatParams
): ChatCompletionCreateParamsNonStreaming {
  const { tier = "normal", timeoutMs: _timeout, webSearch, jsonInPrompt: _prompted, ...rest } = params;
  const request = { ...rest, model } as ChatCompletionCreateParamsNonStreaming & {
    max_tokens?: number | null;
    max_completion_tokens?: number | null;
    plugins?: unknown[];
  };
  if (provider === "GEMINI" && tier !== "thinking" && geminiCanSkipThinking(model) && request.reasoning_effort == null) {
    // Gemini 2.5 Flash thinks by default and counts it against max_tokens:
    // short answers (classification, summaries) would come back empty.
    request.reasoning_effort = "none" as ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
  }
  if (provider === "OPENROUTER" && webSearch) {
    request.plugins = [{ id: "web", max_results: OPENROUTER_WEB_RESULTS }];
  }
  const isOpenAIReasoning = provider === "OPENAI" && /^(gpt-5|o\d)/.test(model);
  if (isOpenAIReasoning) {
    // Reasoning models reject max_tokens and non-default temperatures.
    if (request.max_tokens != null) {
      request.max_completion_tokens = request.max_tokens;
      delete request.max_tokens;
    }
    delete request.temperature;
  } else if (provider !== "OPENAI" && request.max_completion_tokens != null) {
    request.max_tokens = request.max_completion_tokens;
    delete request.max_completion_tokens;
  }
  return request;
}

/** Gemini 2.5 Flash / Flash-Lite can run without thinking; Pro and 3.x cannot. */
function geminiCanSkipThinking(model: string) {
  return /^gemini-2\.5-flash/.test(model);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Google-Search-grounded completion through Gemini's native API (the
 * OpenAI-compatible endpoint has no search tool). Returns an OpenAI-shaped
 * completion so the router treats it like any other attempt.
 */
async function geminiGroundedCompletion(
  fetchImpl: FetchLike,
  apiKey: string,
  model: string,
  params: RouterChatParams
): Promise<{ completion: ChatCompletion; sources: WebSource[] }> {
  const textOf = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string }).text ?? "").join("")
        : "";
  const system = params.messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n\n");
  const contents = params.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: textOf(m.content) }] }));

  const maxTokens = params.max_tokens ?? params.max_completion_tokens;
  const tier = params.tier ?? "normal";
  const response = await fetchImpl(`${GEMINI_NATIVE_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    body: JSON.stringify({
      ...(system && { systemInstruction: { parts: [{ text: system }] } }),
      contents,
      tools: [{ google_search: {} }],
      generationConfig: {
        ...(params.temperature != null && { temperature: params.temperature }),
        ...(maxTokens != null && { maxOutputTokens: maxTokens }),
        ...(tier !== "thinking" && geminiCanSkipThinking(model) && { thinkingConfig: { thinkingBudget: 0 } }),
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw Object.assign(new Error(`Gemini ${response.status}: ${body.slice(0, 300)}`), {
      status: response.status,
      headers: response.headers,
    });
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => !!w?.uri)
    .map((w) => ({ url: w.uri, title: w.title }));

  const completion = {
    id: "gemini-grounded",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
        message: { role: "assistant", content: text, refusal: null },
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  } as ChatCompletion;
  return { completion, sources };
}

/** url_citation annotations that OpenRouter's web plugin attaches to the message. */
function openRouterSources(message: ChatCompletionMessage | undefined): WebSource[] {
  const annotations = (
    message as { annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }> } | undefined
  )?.annotations;
  return (annotations ?? [])
    .filter((a) => a.type === "url_citation" && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation!.url!, title: a.url_citation!.title }));
}

function newRequestId() {
  return randomUUID().slice(0, 8);
}

function aiStep(level: "log" | "warn" | "error", requestId: string, step: string, fields: Record<string, unknown>) {
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  console[level](`[AI-ROUTER] ${requestId} ${step}`, defined);
}

type ClientFactory = (provider: AIProvider, apiKey: string) => Pick<OpenAI, "chat">;

const defaultClientFactory: ClientFactory = (provider, apiKey) =>
  new OpenAI({
    apiKey,
    baseURL: PROVIDERS[provider].baseURL,
    // The router owns retries: fail fast and move to the next model.
    maxRetries: 0,
    defaultHeaders: provider === "OPENROUTER" ? { "X-Title": "NextCRM" } : undefined,
  });

export class AIRouter {
  private clients = new Map<string, Pick<OpenAI, "chat">>();
  private cooldownUntil = new Map<AIProvider, number>();
  private procedureFailures = new Map<string, { count: number; lastFailure: number }>();

  constructor(
    private readonly createClient: ClientFactory = defaultClientFactory,
    private readonly resolveKey: (provider: AIProvider, userId?: string) => Promise<string | null> = getApiKey,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  /** Models for a provider and tier: <PROVIDER>_MODELS[_LIGHT|_THINKING] env override, else defaults. */
  getModels(provider: AIProvider, tier: ModelTier): string[] {
    const envKey = tier === "normal" ? `${provider}_MODELS` : `${provider}_MODELS_${tier.toUpperCase()}`;
    const fromEnv = (process.env[envKey] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return fromEnv.length > 0 ? fromEnv : PROVIDERS[provider].models[tier];
  }

  private getConfiguredOrder(): AIProvider[] {
    const fromEnv = (process.env.AI_PROVIDER_ORDER ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((p): p is AIProvider => p in PROVIDERS);
    return fromEnv.length > 0 ? Array.from(new Set(fromEnv)) : DEFAULT_PROVIDER_ORDER;
  }

  /** Providers with a key, cooling-down ones moved last (still tried as a last resort). */
  async getProviderChain(userId?: string): Promise<Array<{ provider: AIProvider; apiKey: string }>> {
    const available: Array<{ provider: AIProvider; apiKey: string }> = [];
    for (const provider of this.getConfiguredOrder()) {
      const apiKey = await this.resolveKey(provider, userId);
      if (apiKey) available.push({ provider, apiKey });
    }
    const now = Date.now();
    const cooling = (p: AIProvider) => (this.cooldownUntil.get(p) ?? 0) > now;
    return [...available.filter((a) => !cooling(a.provider)), ...available.filter((a) => cooling(a.provider))];
  }

  async hasProvider(userId?: string): Promise<boolean> {
    return (await this.getProviderChain(userId)).length > 0;
  }

  private getClient(provider: AIProvider, apiKey: string) {
    const cacheKey = `${provider}:${apiKey}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = this.createClient(provider, apiKey);
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  private assertProcedureAllowed(procedure: string, requestId: string) {
    const failure = this.procedureFailures.get(procedure);
    if (!failure || failure.count < MAX_PROCEDURE_FAILURES) return;
    const elapsed = Date.now() - failure.lastFailure;
    if (elapsed >= PROCEDURE_COOLDOWN_MS) {
      this.procedureFailures.delete(procedure);
      return;
    }
    const retryInMin = Math.ceil((PROCEDURE_COOLDOWN_MS - elapsed) / 60_000);
    aiStep("error", requestId, "Rejected", { reason: "PROCEDURE_BLOCKED", procedure, retryInMin });
    throw new AIRouterError(
      "PROCEDURE_BLOCKED",
      `AI procedure "${procedure}" is paused for ${retryInMin} min after ${failure.count} complete failures`
    );
  }

  private recordProcedureFailure(procedure: string) {
    const current = this.procedureFailures.get(procedure) ?? { count: 0, lastFailure: 0 };
    this.procedureFailures.set(procedure, { count: current.count + 1, lastFailure: Date.now() });
  }

  /** One model attempt; throws AttemptError when the reply is unusable. */
  private async attempt(
    provider: AIProvider,
    apiKey: string,
    model: string,
    params: RouterChatParams
  ): Promise<{ completion: ChatCompletion; text: string; sources: WebSource[] }> {
    let completion: ChatCompletion;
    let sources: WebSource[] = [];
    try {
      if (params.webSearch && provider === "GEMINI") {
        ({ completion, sources } = await geminiGroundedCompletion(this.fetchImpl, apiKey, model, params));
      } else {
        completion = await this.getClient(provider, apiKey).chat.completions.create(
          buildRequest(provider, model, params),
          { timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS }
        );
        if (params.webSearch) sources = openRouterSources(completion.choices?.[0]?.message);
      }
    } catch (error) {
      throw classifyError(error);
    }

    const choice = completion.choices?.[0];
    if (!choice?.message) throw new AttemptError("empty_response", "no choices returned");
    if (choice.message.tool_calls?.length) return { completion, text: choice.message.content ?? "", sources };

    const content = choice.message.content ?? "";
    const { json } = wantsJson(params);
    if (choice.finish_reason === "length" && (json || !content.trim())) {
      throw new AttemptError("truncated", "response hit the token limit");
    }
    if (!content.trim()) throw new AttemptError("empty_response", "model returned empty content");
    if (!json) return { completion, text: content, sources };

    const parsed = extractJson(content);
    if (parsed === undefined) throw new AttemptError("invalid_json", "response is not valid JSON");
    const text = JSON.stringify(parsed);
    // Hand callers a clean JSON body even if the model wrapped it.
    choice.message.content = text;
    return { completion, text, sources };
  }

  /**
   * OpenAI-style chat completion routed through the provider/model fallback
   * chain. Pass `tier` instead of `model`.
   */
  async chat(params: RouterChatParams, context: AIGenerationContext): Promise<AIChatResult> {
    const requestId = newRequestId();
    const tier = params.tier ?? "normal";
    aiStep("log", requestId, "Request Received", {
      procedure: context.procedure,
      tier,
      json: wantsJson(params).json || undefined,
      tools: params.tools?.length,
      webSearch: params.webSearch || undefined,
      correlationId: context.correlationId,
    });

    this.assertProcedureAllowed(context.procedure, requestId);
    if (params.webSearch && params.tools?.length) {
      throw new Error("webSearch cannot be combined with tools");
    }

    let chain = await this.getProviderChain(context.userId);
    if (params.webSearch) chain = chain.filter((c) => WEB_SEARCH_PROVIDERS.includes(c.provider));
    if (chain.length === 0) {
      throw new AIRouterError(
        "NO_PROVIDER",
        params.webSearch
          ? "Web search needs a Gemini or OpenRouter API key"
          : "No LLM API key configured (OpenAI, Gemini, OpenRouter or Anthropic)"
      );
    }
    aiStep("log", requestId, "Provider Order", { providers: chain.map((c) => c.provider).join(",") });

    const failures: AIRouterError["failures"] = [];
    let attempts = 0;

    for (const { provider, apiKey } of chain) {
      // Grounded Gemini calls cannot combine search with a JSON response mode.
      const nativeJson = PROVIDERS[provider].nativeJsonMode && !(params.webSearch && provider === "GEMINI");
      const providerParams = nativeJson || !wantsJson(params).json ? params : withPromptedJson(params);

      models: for (const model of this.getModels(provider, tier)) {
        let request = providerParams;
        // A 400 on a JSON request gets one retry on the same model with JSON
        // asked for in the prompt (some models reject response_format).
        for (let degraded = false; ; degraded = true) {
          attempts++;
          const started = Date.now();
          aiStep("log", requestId, "Attempt", { provider, model, attempt: attempts, degraded: degraded || undefined });
          try {
            const { completion, text, sources } = await this.attempt(provider, apiKey, model, request);
            this.cooldownUntil.delete(provider);
            this.procedureFailures.delete(context.procedure);
            aiStep("log", requestId, "Complete", {
              provider,
              model,
              attempts,
              durationMs: Date.now() - started,
              tokens: completion.usage?.total_tokens,
            });
            return {
              completion,
              message: completion.choices[0].message,
              text,
              provider,
              modelUsed: model,
              requestId,
              attempts,
              sources,
            };
          } catch (error) {
            const failure = classifyError(error);
            failures.push({ provider, model, error: `${failure.kind}: ${failure.message}` });
            aiStep("warn", requestId, "Attempt Failed", {
              provider,
              model,
              kind: failure.kind,
              durationMs: Date.now() - started,
              error: failure.message.slice(0, 300),
            });

            if (failure.kind === "bad_request" && !degraded && request.response_format) {
              request = withPromptedJson(request);
              continue;
            }
            if (failure.kind === "auth") break models;
            if (failure.kind === "rate_limit") {
              this.cooldownUntil.set(provider, Date.now() + (failure.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS));
              break models;
            }
            continue models;
          }
        }
      }
    }

    this.recordProcedureFailure(context.procedure);
    aiStep("error", requestId, "All Providers Failed", { procedure: context.procedure, attempts });
    throw new AIRouterError(
      "ALL_PROVIDERS_FAILED",
      `All AI providers failed for "${context.procedure}": ${failures
        .map((f) => `${f.provider}/${f.model} ${f.error}`)
        .join("; ")
        .slice(0, 2000)}`,
      failures
    );
  }

  /** System + user prompt → text (or JSON text), with full fallback. */
  async generateContent(
    systemPrompt: string,
    userPrompt: string,
    config: AIGenerationConfig,
    context: AIGenerationContext
  ): Promise<AIGenerationResult> {
    const json = config.responseFormat === "json" || !!config.jsonSchema;
    const result = await this.chat(
      {
        tier: config.tier,
        timeoutMs: config.timeoutMs,
        webSearch: config.webSearch,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(json && {
          response_format: config.jsonSchema
            ? { type: "json_schema", json_schema: { name: config.jsonSchema.name, schema: config.jsonSchema.schema } }
            : { type: "json_object" },
        }),
      },
      context
    );
    return {
      text: result.text,
      usage: result.completion.usage,
      provider: result.provider,
      modelUsed: result.modelUsed,
      requestId: result.requestId,
      attempts: result.attempts,
      sources: result.sources,
    };
  }
}

/** Process-wide router (cooldowns and procedure breakers are shared). */
export const aiRouter = new AIRouter();

export async function hasAnyLlmKey(userId?: string): Promise<boolean> {
  return aiRouter.hasProvider(userId);
}
