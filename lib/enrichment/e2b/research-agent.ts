import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { aiRouter, extractJson, type AIGenerationContext, type AIRouter } from "@/lib/llm/ai-router";
import type { AgentOutput } from "./apply-result";

/**
 * B2B research agent used by target / target-contact enrichment.
 *
 * The tool loop runs in-process so every LLM turn goes through the AI router
 * (provider and model fallback). The E2B sandbox is only the browser: each
 * tool call becomes one `agent-browser` command run inside it.
 */

export interface ResearchInput {
  companyName: string;
  companyWebsite: string;
  email: string;
  targetName: string;
  knownDomain: string;
}

/** Runs a shell command in the sandbox and returns its output (errors included). */
export type CommandRunner = (command: string) => Promise<string>;

const MAX_TURNS = 25;
// Page texts can be huge; keep each tool result within a sane token budget.
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;

export const RESEARCH_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Navigate to a URL in the browser. Always use full URL with https://.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL including https://" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description:
        "Get the accessible text tree of the current page with interactive element refs like @e1, @e2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_text",
      description:
        "Get the full visible text of the current page. Use this after browser_open to read page content for extracting company info.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element by its ref from the snapshot (e.g. @e3)",
      parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for a query. Returns the search results snapshot.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
];

/** POSIX single-quote escaping: tool arguments come from the model and the web. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function browser(...args: string[]): string {
  return ["agent-browser", "--ignore-https-errors", ...args.map(shellQuote)].join(" ");
}

export async function executeResearchTool(
  name: string,
  rawArgs: string,
  run: CommandRunner
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return "error: tool arguments are not valid JSON";
  }
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");

  switch (name) {
    case "browser_open":
      return run(browser("open", str("url")));
    case "browser_snapshot":
      return run(browser("snapshot", "-c"));
    case "browser_get_text":
      return run(browser("get", "text", "body"));
    case "browser_click":
      return run(browser("click", str("ref")));
    case "web_search":
      await run(browser("open", `https://www.bing.com/search?q=${encodeURIComponent(str("query"))}`));
      return run(browser("snapshot", "-c"));
    default:
      return `error: unknown tool ${name}`;
  }
}

export function buildResearchPrompt(input: ResearchInput): string {
  const domainInstruction = input.companyWebsite
    ? `The company website is known: ${input.companyWebsite}. Open it directly — do not search for the domain.`
    : input.knownDomain
      ? `Derive the company domain from the email: ${input.knownDomain}. Open https://${input.knownDomain} directly.`
      : `Search for "${input.companyName} official website" to discover the company domain.`;
  const contactInstruction = input.targetName
    ? `Also specifically find ${input.targetName}'s job title and LinkedIn URL.`
    : "";

  return `You are an expert B2B researcher. Your job is to find all data needed to start outreach to a company.

Known information:
- Company name: ${input.companyName || "unknown"}
- Company website: ${input.companyWebsite || "not known"}
- Contact email: ${input.email || "not known"}
- Contact name: ${input.targetName || "not known"}

Research strategy (follow this order):
1. ${domainInstruction}
2. Use browser_open to navigate to the company website, then browser_get_text to read the full page text. Scan carefully for:
   - Any email address (look for "mailto:" links, "@" patterns)
   - Any phone number (look for "tel:", "+1", area codes, formatted numbers)
   - Company description, industry, employee count, HQ city
   - LinkedIn company URL (linkedin.com/company/...), Twitter/X URL
3. If the homepage lacks phone or email, open the /contact or /about page with browser_open, then browser_get_text again. These pages almost always have phone and email.
4. Use web_search to find C-level contacts: query "CEO OR CTO OR CFO OR CMO OR \\"VP Sales\\" ${input.companyName} site:linkedin.com".
5. For each C-level person found in search results, record their name, title, and LinkedIn URL.
${contactInstruction}

When you have gathered sufficient data (or exhausted reasonable research steps), output ONLY a valid JSON object in this exact format and nothing else:

{
  "target": {
    "company_website": "string or null",
    "industry": "string or null",
    "employees": "string or null",
    "city": "string or null",
    "company_phone": "string or null",
    "social_linkedin": "string or null",
    "social_x": "string or null",
    "description": "string or null"
  },
  "contacts": [
    {
      "name": "string",
      "email": null,
      "title": "string or null",
      "linkedinUrl": "string or null",
      "phone": null,
      "source": "enriched"
    }
  ],
  "confidence": {
    "fieldName": 0.9
  }
}

Rules:
- Output ONLY the JSON — no explanation, no markdown, no code fences
- Set confidence for any field you are not certain about (0.0 to 1.0)
- Set null for fields you could not find
- Do not search for information you already have
- If a URL navigation fails (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_CLOSED, ERR_BLOCKED_BY_CLIENT), do NOT retry the same domain. Move on to the next research step immediately.
- If the company website is unreachable, fall back to web_search to find info about the company.`;
}

function asAgentOutput(text: string | null | undefined): AgentOutput | null {
  if (!text) return null;
  const parsed = extractJson(text) as Partial<AgentOutput> | undefined;
  if (!parsed || typeof parsed !== "object" || (!parsed.target && !parsed.contacts)) return null;
  return { target: parsed.target ?? {}, contacts: parsed.contacts ?? [], confidence: parsed.confidence ?? {} };
}

/** Wraps an E2B sandbox as a CommandRunner (non-zero exits return their output). */
export function sandboxRunner(sandbox: {
  commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> };
}): CommandRunner {
  return async (command) => {
    try {
      const result = await sandbox.commands.run(command, { timeoutMs: COMMAND_TIMEOUT_MS });
      return result.stdout || result.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return err.stdout || err.stderr || `error: ${err.message ?? String(e)}`;
    }
  };
}

export async function runResearchAgent(opts: {
  input: ResearchInput;
  run: CommandRunner;
  context: AIGenerationContext;
  router?: Pick<AIRouter, "chat">;
}): Promise<AgentOutput> {
  const router = opts.router ?? aiRouter;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildResearchPrompt(opts.input) },
    { role: "user", content: "Research this company and return the JSON result." },
  ];
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { message } = await router.chat(
      { tier: "thinking", messages, tools: RESEARCH_TOOLS, max_tokens: 4096, timeoutMs: 120_000 },
      opts.context
    );

    const toolCalls = (message.tool_calls ?? []).filter((c) => c.type === "function");
    if (toolCalls.length > 0) {
      // Keep only portable fields: a fallback may hand the history to another provider.
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      });
      for (const call of toolCalls) {
        const output = await executeResearchTool(call.function.name, call.function.arguments, opts.run);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: (output || "(no output)").slice(0, MAX_TOOL_OUTPUT_CHARS),
        });
      }
      continue;
    }

    const output = asAgentOutput(message.content);
    if (output) return output;
    if (nudged) throw new Error("Research agent did not return the expected JSON");
    nudged = true;
    messages.push({ role: "assistant", content: message.content ?? "" });
    messages.push({ role: "user", content: "Return ONLY the JSON object in the required format now." });
  }

  // Out of turns: ask for the result from what was gathered, without tools.
  const { message } = await router.chat(
    {
      tier: "thinking",
      messages: [...messages, { role: "user", content: "Stop researching. Return ONLY the JSON object now." }],
      // The history holds tool calls, so tools stay declared but disabled.
      tools: RESEARCH_TOOLS,
      tool_choice: "none",
      max_tokens: 4096,
      timeoutMs: 120_000,
    },
    opts.context
  );
  const output = asAgentOutput(message.content);
  if (!output) throw new Error("Research agent did not return the expected JSON");
  return output;
}
