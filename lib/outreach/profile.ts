import { aiRouter, AIRouterError, type AIGenerationContext, type WebSource } from "@/lib/llm/ai-router";

/**
 * Prospect profile for AI outreach: the professional profile found on the web
 * (LinkedIn first, via search-grounded models) and a persona derived from the
 * job title. Stored on crm_Targets.outreach_profile and reused by every message.
 */

export interface OutreachTargetData {
  first_name: string | null;
  last_name: string;
  email: string | null;
  company: string | null;
  company_website: string | null;
  position: string | null;
  social_linkedin: string | null;
  city: string | null;
  country: string | null;
  industry: string | null;
  employees: string | null;
  description: string | null;
}

export interface ProfessionalProfile {
  linkedinUrl: string | null;
  currentTitle: string | null;
  company: string | null;
  headline: string | null;
  location: string | null;
  /** 2-4 sentences on background, scope and recent activity. */
  summary: string | null;
  /** Concrete, verifiable facts usable as a personal hook. */
  highlights: string[];
  confidence: number;
}

export interface Persona {
  /** e.g. "Sales leadership", "Bid / proposal management", "Executive management" */
  roleFamily: string;
  seniority: "C-level" | "VP / Director" | "Head / Manager" | "Individual contributor" | "Unknown";
  department: string | null;
  decisionRole: "Decision maker" | "Influencer" | "User" | "Unknown";
  priorities: string[];
  likelyPains: string[];
  /** One sentence: the angle a message to this person should take. */
  angle: string;
}

export interface OutreachProfile {
  professional: ProfessionalProfile;
  persona: Persona;
  /** "web": found with live search; "crm": built from the imported data only. */
  researchedWith: "web" | "crm";
  sources: WebSource[];
  /** Why the web research was skipped or failed, if it was. */
  researchNote?: string;
}

export function fullName(t: Pick<OutreachTargetData, "first_name" | "last_name">) {
  return [t.first_name, t.last_name].filter(Boolean).join(" ").trim();
}

function crmFacts(t: OutreachTargetData): string {
  const facts: Array<[string, string | null]> = [
    ["Name", fullName(t)],
    ["Job title (from the imported list)", t.position],
    ["Company", t.company],
    ["Company website", t.company_website],
    ["LinkedIn URL (from the imported list)", t.social_linkedin],
    ["Email domain", t.email?.split("@")[1] ?? null],
    ["Location", [t.city, t.country].filter(Boolean).join(", ") || null],
    ["Industry", t.industry],
    ["Company size", t.employees],
    ["Company description", t.description?.slice(0, 600) ?? null],
  ];
  return facts
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const strList = (v: unknown, max = 6) =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => !!s).slice(0, max) : [];

function asProfessional(raw: unknown, t: OutreachTargetData): ProfessionalProfile {
  const r = (raw ?? {}) as Record<string, unknown>;
  const linkedin = str(r.linkedinUrl);
  return {
    // Keep the imported URL when the model found none (or an invalid one).
    linkedinUrl: linkedin && /linkedin\.com\/in\//i.test(linkedin) ? linkedin : t.social_linkedin,
    currentTitle: str(r.currentTitle) ?? t.position,
    company: str(r.company) ?? t.company,
    headline: str(r.headline),
    location: str(r.location) ?? ([t.city, t.country].filter(Boolean).join(", ") || null),
    summary: str(r.summary),
    highlights: strList(r.highlights),
    confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
  };
}

const SENIORITIES: Persona["seniority"][] = ["C-level", "VP / Director", "Head / Manager", "Individual contributor", "Unknown"];
const DECISION_ROLES: Persona["decisionRole"][] = ["Decision maker", "Influencer", "User", "Unknown"];

function asPersona(raw: unknown): Persona {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: T[]): T =>
    (allowed as string[]).includes(v as string) ? (v as T) : allowed[allowed.length - 1];
  return {
    roleFamily: str(r.roleFamily) ?? "Unknown",
    seniority: pick(r.seniority, SENIORITIES),
    department: str(r.department),
    decisionRole: pick(r.decisionRole, DECISION_ROLES),
    priorities: strList(r.priorities, 5),
    likelyPains: strList(r.likelyPains, 5),
    angle: str(r.angle) ?? "",
  };
}

const RESEARCH_PROMPT = `You are a B2B sales researcher. Use web search to find the professional profile of one specific person, starting with their LinkedIn profile (search e.g. "<full name> <company> LinkedIn"), then their company page, interviews, articles or talks.

Rules:
- Only report facts you actually saw in the search results. Never guess or invent.
- Make sure the profile is the right person: same name AND same company (or a clearly matching previous role). If unsure, lower "confidence" and leave fields null.
- "linkedinUrl" must be a linkedin.com/in/ URL seen in the results, otherwise null.
- "highlights": up to 5 short, concrete facts usable to personalise a message (current responsibilities, recent role change, published post or talk, company news). No generic statements.

Return a JSON object:
{"linkedinUrl": string|null, "currentTitle": string|null, "company": string|null, "headline": string|null, "location": string|null, "summary": string|null, "highlights": string[], "confidence": number}`;

const PERSONA_PROMPT = `You are a B2B sales strategist. From a prospect's job title and professional profile, infer their persona so a salesperson can write a relevant first message.

Return a JSON object:
{"roleFamily": string, "seniority": "C-level"|"VP / Director"|"Head / Manager"|"Individual contributor"|"Unknown", "department": string|null, "decisionRole": "Decision maker"|"Influencer"|"User"|"Unknown", "priorities": string[], "likelyPains": string[], "angle": string}

- "roleFamily": the function in a few words (e.g. "Sales leadership", "Bid / proposal management", "Executive management", "Pre-sales").
- "priorities" / "likelyPains": 2 to 4 items each, specific to this role and company context, phrased as the prospect would.
- "angle": one sentence on what a first message to this person should focus on.
Base everything on the title and the facts given; when the title is missing or ambiguous, say so with "Unknown".`;

/** Search the web for the prospect, then derive the persona from the title. */
export async function buildOutreachProfile(
  target: OutreachTargetData,
  context: AIGenerationContext
): Promise<OutreachProfile> {
  const facts = crmFacts(target);
  let professional: ProfessionalProfile = asProfessional({}, target);
  let researchedWith: OutreachProfile["researchedWith"] = "crm";
  let sources: WebSource[] = [];
  let researchNote: string | undefined;

  try {
    const result = await aiRouter.generateContent(
      RESEARCH_PROMPT,
      `Person to research:\n${facts}`,
      { tier: "normal", responseFormat: "json", webSearch: true, temperature: 0.1, maxTokens: 1500, timeoutMs: 90_000 },
      { ...context, procedure: "outreach.researchProfile" }
    );
    professional = asProfessional(JSON.parse(result.text), target);
    researchedWith = "web";
    sources = result.sources.slice(0, 8);
  } catch (error) {
    // A profile built from the imported data still lets the message be written.
    if (!(error instanceof AIRouterError)) throw error;
    researchNote =
      error.code === "NO_PROVIDER"
        ? "Web research needs a Gemini or OpenRouter key: profile built from the imported data."
        : `Web research failed (${error.code}): profile built from the imported data.`;
  }

  const persona = await aiRouter.generateContent(
    PERSONA_PROMPT,
    `Imported data:\n${facts}\n\nProfessional profile:\n${JSON.stringify(professional, null, 2)}`,
    { tier: "light", responseFormat: "json", temperature: 0.2, maxTokens: 800 },
    { ...context, procedure: "outreach.analyzePersona" }
  );

  return {
    professional,
    persona: asPersona(JSON.parse(persona.text)),
    researchedWith,
    sources,
    ...(researchNote && { researchNote }),
  };
}
