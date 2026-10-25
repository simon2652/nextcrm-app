import { aiRouter, type AIGenerationContext } from "@/lib/llm/ai-router";
import { findForbiddenTerms } from "@/lib/knowledge/confidentiality";
import type { RetrievedKnowledge } from "@/lib/knowledge/retrieve";
import { fullName, type OutreachProfile, type OutreachTargetData } from "./profile";
import { CHANNEL_MAX_CHARS, OUTREACH_LANGUAGES, type OutreachChannel } from "./constants";

export { CHANNEL_MAX_CHARS, OUTREACH_BULK_MAX, OUTREACH_LANGUAGES, type OutreachChannel } from "./constants";

const CHANNEL_RULES: Record<OutreachChannel, string> = {
  EMAIL: `Channel: cold email.
- "subject": short and specific (max 60 characters), no clickbait, no emoji.
- "body": plain text, 90 to 150 words, short paragraphs. Greeting with the first name, one personal hook, the value for this persona, one low-friction call to action (e.g. a 15-minute call), then the sender's name as signature.`,
  LINKEDIN: `Channel: LinkedIn message.
- "subject": null.
- "body": at most ${CHANNEL_MAX_CHARS.LINKEDIN} characters (at most 300 if the instructions ask for a connection request note). Conversational but professional, no formatting, no links, ends with a light question.`,
  WHATSAPP: `Channel: WhatsApp message.
- "subject": null.
- "body": at most ${CHANNEL_MAX_CHARS.WHATSAPP} characters, 2 or 3 very short paragraphs, courteous, introduces the sender in the first line, one simple question. No markdown, at most one emoji.`,
};

export interface WriteOutreachInput {
  target: OutreachTargetData;
  profile: OutreachProfile;
  channel: OutreachChannel;
  language: string;
  instructions?: string | null;
  sender: { name: string | null };
  knowledge: RetrievedKnowledge;
  context: AIGenerationContext;
}

export interface OutreachDraft {
  subject: string | null;
  body: string;
  warnings: string[];
  modelUsed: string;
}

/** Retrieval query: who the prospect is and what the user wants to say. */
export function knowledgeQuery(target: OutreachTargetData, profile: OutreachProfile, instructions?: string | null) {
  const p = profile.persona;
  return [
    `Messaging and value proposition for a ${p.seniority} ${p.roleFamily} (${profile.professional.currentTitle ?? target.position ?? ""})`,
    target.industry && `in the ${target.industry} industry`,
    target.employees && `company size ${target.employees}`,
    p.likelyPains.length && `pains: ${p.likelyPains.join("; ")}`,
    p.priorities.length && `priorities: ${p.priorities.join("; ")}`,
    instructions && `focus: ${instructions}`,
    "objections, proof points, differentiators",
  ]
    .filter(Boolean)
    .join(". ");
}

function knowledgeBlock(knowledge: RetrievedKnowledge): string {
  if (knowledge.excerpts.length === 0) return "(no product knowledge available — stay generic about the offer and never invent claims)";
  return knowledge.excerpts
    .map((e) => `<<<SOURCE: ${e.document}${e.heading ? ` — ${e.heading}` : ""}>>>\n${e.content}\n<<<END SOURCE>>>`)
    .join("\n\n");
}

function systemPrompt(input: WriteOutreachInput): string {
  const language = OUTREACH_LANGUAGES[input.language] ?? "French";
  return `You are an expert B2B copywriter writing a first-touch prospecting message on behalf of a salesperson.

${CHANNEL_RULES[input.channel]}

Writing rules:
- Write in ${language}${input.language === "fr" ? ", using \"vous\"" : ""}. Natural, human tone; no buzzwords, no flattery, no generic opening ("I hope this message finds you well").
- Personalise from the prospect's actual role, company and profile facts below. Use at most one personal hook and only facts given to you — never invent anything about the prospect.
- Every statement about the product must be supported by the PRODUCT KNOWLEDGE sources. Never invent figures, customer names, results or features. Respect the evidence status the sources give (do not present a hypothesis or an unmeasured outcome as a proven result).
- Speak to this persona's priorities and pains; one clear idea per message.
- Confidentiality: never name a customer, prospect, partner or competitor mentioned in the knowledge or rules; use generic descriptors instead (e.g. "a large engineering group").
- The salesperson's instructions below take precedence over these style defaults, but never over truthfulness or confidentiality.
${input.knowledge.rules ? `\nCONFIDENTIALITY RULES:\n${input.knowledge.rules}\n` : ""}
Return a JSON object: {"subject": string|null, "body": string}`;
}

function userPrompt(input: WriteOutreachInput): string {
  const { target, profile } = input;
  return `PROSPECT
- Name: ${fullName(target)}
- Title: ${profile.professional.currentTitle ?? target.position ?? "unknown"}
- Company: ${profile.professional.company ?? target.company ?? "unknown"}${target.industry ? ` (${target.industry})` : ""}
- Location: ${profile.professional.location ?? "unknown"}
- Headline: ${profile.professional.headline ?? "n/a"}
- Profile summary: ${profile.professional.summary ?? "n/a"}
- Personal hooks: ${profile.professional.highlights.join(" | ") || "none found"}

PERSONA
${JSON.stringify(profile.persona, null, 2)}

SENDER
- Name: ${input.sender.name ?? "(leave the signature as the sender's first name placeholder)"}

SALESPERSON INSTRUCTIONS
${input.instructions?.trim() || "(none)"}

PRODUCT KNOWLEDGE
${knowledgeBlock(input.knowledge)}`;
}

function parseDraft(text: string): { subject: string | null; body: string } {
  const raw = JSON.parse(text) as { subject?: unknown; body?: unknown };
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) throw new Error("The model returned an empty message");
  const subject = typeof raw.subject === "string" && raw.subject.trim() ? raw.subject.trim() : null;
  return { subject, body };
}

/**
 * Write the message, then enforce confidentiality and length: one rewrite pass
 * if a forbidden name slipped in or the channel limit is exceeded; whatever is
 * still wrong is returned as a warning for the salesperson to fix.
 */
export async function writeOutreachMessage(input: WriteOutreachInput): Promise<OutreachDraft> {
  const procedure = `outreach.write.${input.channel.toLowerCase()}`;
  const config = { tier: "normal" as const, responseFormat: "json" as const, temperature: 0.6, maxTokens: 1500 };
  const exceptions = [input.target.company, input.profile.professional.company].filter((c): c is string => !!c);

  const first = await aiRouter.generateContent(systemPrompt(input), userPrompt(input), config, {
    ...input.context,
    procedure,
  });
  let draft = parseDraft(first.text);
  let modelUsed = `${first.provider}/${first.modelUsed}`;

  const problems = (d: { subject: string | null; body: string }) => {
    const issues: string[] = [];
    const leaked = findForbiddenTerms(`${d.subject ?? ""}\n${d.body}`, input.knowledge.forbiddenTerms, exceptions);
    if (leaked.length) issues.push(`Confidential names must not appear: ${leaked.join(", ")}`);
    if (d.body.length > CHANNEL_MAX_CHARS[input.channel]) {
      issues.push(`Too long: ${d.body.length} characters, the limit is ${CHANNEL_MAX_CHARS[input.channel]}`);
    }
    return issues;
  };

  let issues = problems(draft);
  if (issues.length > 0) {
    const rewrite = await aiRouter.generateContent(
      systemPrompt(input),
      `${userPrompt(input)}\n\nPREVIOUS DRAFT\n${JSON.stringify(draft)}\n\nFix these problems and return the corrected JSON:\n- ${issues.join("\n- ")}`,
      config,
      { ...input.context, procedure }
    );
    draft = parseDraft(rewrite.text);
    modelUsed = `${rewrite.provider}/${rewrite.modelUsed}`;
    issues = problems(draft);
  }

  return { ...draft, warnings: issues, modelUsed };
}
