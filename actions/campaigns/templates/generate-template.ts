"use server";
import { aiRouter, AIRouterError } from "@/lib/llm/ai-router";
import { requireAuthenticated, AuthenticationError } from "@/lib/authz";

export const generateTemplate = async (
  prompt: string
): Promise<{
  html: string;
  json: object;
  subject: string;
}> => {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) throw new Error("Unauthorized");
    throw e;
  }

  let text: string;
  try {
    ({ text } = await aiRouter.generateContent(
      `You are an email copywriter. Generate a professional HTML email body and subject line.
Return ONLY valid JSON in this exact format: {"subject":"...", "html":"..."}
The HTML should be clean, inline-styled, suitable for email clients.
Use merge tags {{first_name}}, {{last_name}}, {{email}}, {{company}}, {{position}} where appropriate.`,
      prompt,
      { tier: "light", responseFormat: "json", temperature: 0.7, timeoutMs: 30_000 },
      { userId: user.id, procedure: "campaigns.templates.generate" }
    ));
  } catch (e) {
    if (e instanceof AIRouterError && e.code === "NO_PROVIDER") {
      throw new Error(
        "No LLM API key configured (OpenAI, Gemini, OpenRouter or Anthropic). Add one in Profile → LLMs."
      );
    }
    throw e;
  }

  const parsed = JSON.parse(text) as { subject?: string; html?: string };

  return {
    subject: parsed.subject ?? "",
    html: parsed.html ?? "",
    json: {}, // TipTap will parse the HTML on load via setContent
  };
};
