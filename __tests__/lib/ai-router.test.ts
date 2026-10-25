/**
 * AI router: provider/model fallback chain, error classification, cooldowns
 * and the per-procedure breaker.
 */
import { AIRouter, AIRouterError, extractJson, type AIProvider } from "@/lib/llm/ai-router";

type Call = { provider: AIProvider; model: string; request: any };

function completion(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null }, logprobs: null, ...extra }],
  };
}

const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

/**
 * Router over fake clients. `behaviour` decides each attempt's outcome from
 * (provider, model); every call is recorded in order.
 */
function makeRouter(
  keys: Partial<Record<AIProvider, string>>,
  behaviour: (provider: AIProvider, model: string, request: any) => unknown
) {
  const calls: Call[] = [];
  const router = new AIRouter(
    (provider) => ({
      chat: {
        completions: {
          create: (async (request: any) => {
            calls.push({ provider, model: request.model, request });
            const out = behaviour(provider, request.model, request);
            if (out instanceof Error) throw out;
            return out;
          }) as any,
        },
      } as any,
    }),
    async (provider) => keys[provider] ?? null
  );
  return { router, calls };
}

const ctx = { procedure: "test.procedure" };
const prompt = { messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }] };

beforeEach(() => {
  delete process.env.AI_PROVIDER_ORDER;
  delete process.env.GEMINI_MODELS;
  delete process.env.OPENAI_MODELS_LIGHT;
});

describe("provider chain", () => {
  it("only uses providers with a key, in the default order", async () => {
    const { router } = makeRouter({ GEMINI: "g", ANTHROPIC: "a" }, () => completion("ok"));
    expect((await router.getProviderChain()).map((c) => c.provider)).toEqual(["GEMINI", "ANTHROPIC"]);
  });

  it("honours AI_PROVIDER_ORDER", async () => {
    process.env.AI_PROVIDER_ORDER = "openrouter, gemini";
    const { router } = makeRouter({ OPENAI: "o", GEMINI: "g", OPENROUTER: "r" }, () => completion("ok"));
    expect((await router.getProviderChain()).map((c) => c.provider)).toEqual(["OPENROUTER", "GEMINI"]);
  });

  it("throws NO_PROVIDER without any key", async () => {
    const { router } = makeRouter({}, () => completion("ok"));
    await expect(router.chat(prompt, ctx)).rejects.toMatchObject({ code: "NO_PROVIDER" });
    expect(await router.hasProvider()).toBe(false);
  });
});

describe("fallback", () => {
  it("tries the next model of the same provider on 404 / timeout / empty reply", async () => {
    process.env.GEMINI_MODELS = "g-1,g-2,g-3,g-4";
    const { router, calls } = makeRouter({ GEMINI: "g" }, (_p, model) => {
      if (model === "g-1") return httpError(404);
      if (model === "g-2") return Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
      if (model === "g-3") return completion("   ");
      return completion("answer");
    });

    const result = await router.chat(prompt, ctx);

    expect(calls.map((c) => c.model)).toEqual(["g-1", "g-2", "g-3", "g-4"]);
    expect(result).toMatchObject({ text: "answer", provider: "GEMINI", modelUsed: "g-4", attempts: 4 });
  });

  it("skips the rest of a provider on 401 and moves to the next provider", async () => {
    const { router, calls } = makeRouter({ OPENAI: "bad", GEMINI: "g" }, (provider) =>
      provider === "OPENAI" ? httpError(401) : completion("from gemini")
    );
    const result = await router.chat(prompt, ctx);
    expect(calls.filter((c) => c.provider === "OPENAI")).toHaveLength(1);
    expect(result.provider).toBe("GEMINI");
  });

  it("puts a rate-limited provider in cooldown at the end of the chain", async () => {
    let limited = true;
    const { router, calls } = makeRouter({ OPENAI: "o", GEMINI: "g" }, (provider) => {
      if (provider === "OPENAI" && limited) return httpError(429);
      return completion("ok");
    });

    expect((await router.chat(prompt, ctx)).provider).toBe("GEMINI");
    expect(calls.filter((c) => c.provider === "OPENAI")).toHaveLength(1);

    limited = false;
    expect((await router.getProviderChain()).map((c) => c.provider)).toEqual(["GEMINI", "OPENAI"]);
  });

  it("maps tiers to provider models, with env overrides", async () => {
    process.env.OPENAI_MODELS_LIGHT = "custom-mini";
    const { router, calls } = makeRouter({ OPENAI: "o" }, () => completion("ok"));
    await router.chat({ ...prompt, tier: "light" }, ctx);
    await router.chat({ ...prompt, tier: "thinking" }, ctx);
    expect(calls.map((c) => c.model)).toEqual(["custom-mini", "gpt-5"]);
  });

  it("reports every failed attempt when all providers fail", async () => {
    const { router } = makeRouter({ OPENAI: "o", GEMINI: "g" }, () => httpError(500));
    const error = await router.chat(prompt, ctx).catch((e) => e);
    expect(error).toBeInstanceOf(AIRouterError);
    expect(error.code).toBe("ALL_PROVIDERS_FAILED");
    expect(error.failures.length).toBe(4); // 2 models × 2 providers
  });
});

describe("JSON responses", () => {
  const jsonPrompt = { ...prompt, response_format: { type: "json_object" as const } };

  it("repairs fenced JSON and hands back clean JSON text", async () => {
    const { router } = makeRouter({ GEMINI: "g" }, () => completion('```json\n{"a":1}\n```'));
    const result = await router.chat(jsonPrompt, ctx);
    expect(result.text).toBe('{"a":1}');
    expect(result.completion.choices[0].message.content).toBe('{"a":1}');
  });

  it("treats invalid or truncated JSON as a failed attempt", async () => {
    process.env.GEMINI_MODELS = "g-1,g-2,g-3";
    const { router } = makeRouter({ GEMINI: "g" }, (_p, model) => {
      if (model === "g-1") return completion("not json at all");
      if (model === "g-2") return { ...completion('{"a":'), choices: [{ ...completion('{"a":').choices[0], finish_reason: "length" }] };
      return completion('{"ok":true}');
    });
    const result = await router.chat(jsonPrompt, ctx);
    expect(result).toMatchObject({ modelUsed: "g-3", text: '{"ok":true}' });
  });

  it("retries a 400 once on the same model with JSON asked in the prompt", async () => {
    const { router, calls } = makeRouter({ GEMINI: "g" }, (_p, _m, request) =>
      request.response_format ? httpError(400, "response_format not supported") : completion('{"a":1}')
    );
    const result = await router.chat(jsonPrompt, ctx);
    expect(calls[0].model).toBe(calls[1].model);
    expect(calls[1].request.response_format).toBeUndefined();
    expect(calls[1].request.messages[0].content).toContain("valid JSON");
    expect(result.text).toBe('{"a":1}');
  });

  it("asks Anthropic for JSON in the prompt instead of response_format", async () => {
    const { router, calls } = makeRouter({ ANTHROPIC: "a" }, () => completion('Sure: {"a":1}'));
    const result = await router.chat(jsonPrompt, ctx);
    expect(result.text).toBe('{"a":1}'); // still validated and cleaned
    expect(calls[0].request.response_format).toBeUndefined();
    expect(calls[0].request.jsonInPrompt).toBeUndefined();
    expect(calls[0].request.messages[0].content).toContain("valid JSON");
  });
});

describe("provider-specific parameters", () => {
  it("uses max_completion_tokens and default temperature for OpenAI reasoning models", async () => {
    const { router, calls } = makeRouter({ OPENAI: "o" }, () => completion("ok"));
    await router.chat({ ...prompt, tier: "thinking", max_tokens: 100, temperature: 0.2 }, ctx);
    expect(calls[0].request).toMatchObject({ model: "gpt-5", max_completion_tokens: 100 });
    expect(calls[0].request.max_tokens).toBeUndefined();
    expect(calls[0].request.temperature).toBeUndefined();
  });

  it("returns tool calls without requiring text content", async () => {
    const toolCall = { id: "t1", type: "function", function: { name: "web_search", arguments: "{}" } };
    const { router } = makeRouter({ GEMINI: "g" }, () => ({
      ...completion(null),
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [toolCall] } }],
    }));
    const result = await router.chat({ ...prompt, tools: [] }, ctx);
    expect(result.message.tool_calls).toEqual([toolCall]);
  });
});

describe("Gemini thinking", () => {
  it("turns thinking off for Flash models on light / normal tiers only", async () => {
    process.env.GEMINI_MODELS = "gemini-2.5-flash";
    const { router, calls } = makeRouter({ GEMINI: "g" }, () => completion("ok"));
    await router.chat({ ...prompt, tier: "normal" }, ctx);
    await router.chat({ ...prompt, tier: "thinking" }, ctx);
    expect(calls[0].request.reasoning_effort).toBe("none");
    expect(calls[1].request.reasoning_effort).toBeUndefined();
  });
});

describe("web search", () => {
  const groundedResponse = (text: string) =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text }] },
            finishReason: "STOP",
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://linkedin.com/in/jane", title: "linkedin.com" } }] },
          },
        ],
        usageMetadata: { totalTokenCount: 42 },
      }),
      { status: 200 }
    );

  function searchRouter(keys: Partial<Record<AIProvider, string>>, fetchImpl: jest.Mock) {
    const calls: Call[] = [];
    const router = new AIRouter(
      (provider) => ({
        chat: {
          completions: {
            create: (async (request: any) => {
              calls.push({ provider, model: request.model, request });
              return {
                ...completion('{"title":"CTO"}'),
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: '{"title":"CTO"}',
                      annotations: [{ type: "url_citation", url_citation: { url: "https://acme.com/team", title: "Team" } }],
                    },
                  },
                ],
              };
            }) as any,
          },
        } as any,
      }),
      async (provider) => keys[provider] ?? null,
      fetchImpl
    );
    return { router, calls };
  }
  const jsonSearch = { ...prompt, webSearch: true, response_format: { type: "json_object" as const } };

  it("grounds Gemini with Google Search through the native API, JSON asked in the prompt", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(groundedResponse('```json\n{"title":"CTO"}\n```'));
    const { router, calls } = searchRouter({ OPENAI: "o", GEMINI: "g" }, fetchImpl);

    const result = await router.chat(jsonSearch, ctx);

    expect(calls).toHaveLength(0); // OpenAI has no search: left out of the chain
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/models\/gemini-2\.5-flash:generateContent$/);
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.systemInstruction.parts[0].text).toContain("valid JSON");
    expect(result).toMatchObject({ provider: "GEMINI", text: '{"title":"CTO"}' });
    expect(result.sources).toEqual([{ url: "https://linkedin.com/in/jane", title: "linkedin.com" }]);
  });

  it("falls back to OpenRouter's web plugin when Gemini is rate limited", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response("quota", { status: 429 }));
    const { router, calls } = searchRouter({ GEMINI: "g", OPENROUTER: "r" }, fetchImpl);

    const result = await router.chat(jsonSearch, ctx);

    expect(result.provider).toBe("OPENROUTER");
    expect(calls[0].request.plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(result.sources).toEqual([{ url: "https://acme.com/team", title: "Team" }]);
  });

  it("throws NO_PROVIDER when no search-capable key is configured", async () => {
    const { router } = searchRouter({ OPENAI: "o", ANTHROPIC: "a" }, jest.fn());
    await expect(router.chat(jsonSearch, ctx)).rejects.toMatchObject({ code: "NO_PROVIDER" });
  });
});

describe("procedure breaker", () => {
  it("blocks a procedure after 3 complete failures, other procedures still run", async () => {
    let down = true;
    const { router } = makeRouter({ GEMINI: "g" }, () => (down ? httpError(503) : completion("ok")));

    for (let i = 0; i < 3; i++) {
      await expect(router.chat(prompt, ctx)).rejects.toMatchObject({ code: "ALL_PROVIDERS_FAILED" });
    }
    down = false;
    await expect(router.chat(prompt, ctx)).rejects.toMatchObject({ code: "PROCEDURE_BLOCKED" });
    await expect(router.chat(prompt, { procedure: "other" })).resolves.toMatchObject({ text: "ok" });
  });
});

describe("extractJson", () => {
  it("finds JSON inside prose", () => {
    expect(extractJson('Here you go: {"a": [1, 2]} hope it helps')).toEqual({ a: [1, 2] });
    expect(extractJson("nothing here")).toBeUndefined();
  });
});
