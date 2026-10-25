/**
 * Target research agent: in-process tool loop over the AI router, with the
 * browser commands executed in the (mocked) sandbox.
 */
import { runResearchAgent, executeResearchTool, shellQuote } from "@/lib/enrichment/e2b/research-agent";

const input = {
  companyName: "Acme",
  companyWebsite: "",
  email: "jane@acme.com",
  targetName: "Jane Doe",
  knownDomain: "acme.com",
};
const context = { userId: "u1", procedure: "enrichment.target", correlationId: "enr-1" };

const toolTurn = (name: string, args: object) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  },
});
const textTurn = (content: string) => ({ message: { role: "assistant", content } });

const RESULT = {
  target: { industry: "Software", city: "Paris" },
  contacts: [{ name: "Jane Doe", email: null, title: "CEO", linkedinUrl: "https://linkedin.com/in/jane", phone: null, source: "enriched" }],
  confidence: { industry: 0.9 },
};

it("runs browser tools in the sandbox and returns the agent JSON", async () => {
  const chat = jest
    .fn()
    .mockResolvedValueOnce(toolTurn("browser_open", { url: "https://acme.com" }))
    .mockResolvedValueOnce(toolTurn("web_search", { query: "CEO Acme" }))
    .mockResolvedValueOnce(textTurn(JSON.stringify(RESULT)));
  const run = jest.fn().mockResolvedValue("page text");

  const output = await runResearchAgent({ input, run, context, router: { chat } as any });

  expect(output).toEqual(RESULT);
  expect(run.mock.calls.map((c) => c[0])).toEqual([
    "agent-browser --ignore-https-errors 'open' 'https://acme.com'",
    "agent-browser --ignore-https-errors 'open' 'https://www.bing.com/search?q=CEO%20Acme'",
    "agent-browser --ignore-https-errors 'snapshot' '-c'",
  ]);

  // Every turn goes through the router with the caller's context, tools and the thinking tier.
  expect(chat).toHaveBeenCalledTimes(3);
  const [params, ctx] = chat.mock.calls[2];
  expect(ctx).toEqual(context);
  expect(params.tier).toBe("thinking");
  expect(params.tools.map((t: any) => t.function.name)).toContain("web_search");
  // Tool results are fed back as tool messages tied to their call id.
  expect(params.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual([
    "call-browser_open",
    "call-web_search",
  ]);
});

it("nudges once when the model answers without JSON", async () => {
  const chat = jest
    .fn()
    .mockResolvedValueOnce(textTurn("I found some things."))
    .mockResolvedValueOnce(textTurn("```json\n" + JSON.stringify(RESULT) + "\n```"));

  const output = await runResearchAgent({ input, run: jest.fn(), context, router: { chat } as any });

  expect(output.target).toEqual(RESULT.target);
  expect(chat.mock.calls[1][0].messages.at(-1).content).toMatch(/Return ONLY the JSON/);
});

it("fails when the model never produces the JSON", async () => {
  const chat = jest.fn().mockResolvedValue(textTurn("no idea"));
  await expect(runResearchAgent({ input, run: jest.fn(), context, router: { chat } as any })).rejects.toThrow(
    "did not return the expected JSON"
  );
});

it("quotes tool arguments so model or web content cannot inject shell commands", async () => {
  const run = jest.fn().mockResolvedValue("");
  await executeResearchTool("browser_open", JSON.stringify({ url: "https://x.io/'; rm -rf / #" }), run);
  expect(run.mock.calls[0][0]).toBe(
    `agent-browser --ignore-https-errors 'open' ${shellQuote("https://x.io/'; rm -rf / #")}`
  );
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
});

it("reports malformed tool arguments to the model instead of crashing", async () => {
  expect(await executeResearchTool("browser_open", "{not json", jest.fn())).toMatch(/not valid JSON/);
  expect(await executeResearchTool("rm_rf", "{}", jest.fn())).toMatch(/unknown tool/);
});
