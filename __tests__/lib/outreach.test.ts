/**
 * AI outreach: profile research with fallback, and message writing with the
 * confidentiality / length guard.
 */
jest.mock("@/lib/llm/ai-router", () => {
  class AIRouterError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return { aiRouter: { generateContent: jest.fn() }, AIRouterError };
});

import { aiRouter, AIRouterError } from "@/lib/llm/ai-router";
import { buildOutreachProfile, type OutreachProfile } from "@/lib/outreach/profile";
import { knowledgeQuery, writeOutreachMessage } from "@/lib/outreach/write";

const generate = aiRouter.generateContent as jest.Mock;
const reply = (json: object, extra: object = {}) => ({
  text: JSON.stringify(json),
  provider: "GEMINI",
  modelUsed: "gemini-2.5-flash",
  sources: [],
  ...extra,
});

const target = {
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@acme.com",
  company: "Acme",
  company_website: null,
  position: "Head of Bids",
  social_linkedin: "https://www.linkedin.com/in/jane-doe",
  city: "Paris",
  country: "France",
  industry: "Engineering",
  employees: "5000",
  description: null,
};
const context = { userId: "u1", procedure: "outreach" };

beforeEach(() => generate.mockReset());

describe("buildOutreachProfile", () => {
  it("researches with web search, then derives the persona from the title", async () => {
    generate
      .mockResolvedValueOnce(
        reply(
          { linkedinUrl: "not a linkedin url", currentTitle: "Bid Director", highlights: ["Joined Acme in 2025"], confidence: 0.9 },
          { sources: [{ url: "https://linkedin.com/in/jane-doe" }] }
        )
      )
      .mockResolvedValueOnce(reply({ roleFamily: "Bid management", seniority: "VP / Director", likelyPains: ["Too many RFPs"] }));

    const profile = await buildOutreachProfile(target, context);

    const [, , researchConfig, researchCtx] = generate.mock.calls[0];
    expect(researchConfig).toMatchObject({ webSearch: true, responseFormat: "json" });
    expect(researchCtx.procedure).toBe("outreach.researchProfile");
    expect(profile.researchedWith).toBe("web");
    // An invalid URL from the model never replaces the imported one.
    expect(profile.professional.linkedinUrl).toBe(target.social_linkedin);
    expect(profile.professional.currentTitle).toBe("Bid Director");
    expect(profile.persona).toMatchObject({ seniority: "VP / Director", decisionRole: "Unknown" });
    expect(profile.sources).toHaveLength(1);
  });

  it("falls back to the imported data when no search provider is configured", async () => {
    generate
      .mockRejectedValueOnce(new (AIRouterError as any)("NO_PROVIDER", "no key"))
      .mockResolvedValueOnce(reply({ roleFamily: "Bid management", seniority: "Head / Manager" }));

    const profile = await buildOutreachProfile(target, context);

    expect(profile.researchedWith).toBe("crm");
    expect(profile.professional.currentTitle).toBe("Head of Bids");
    expect(profile.researchNote).toMatch(/Gemini or OpenRouter/);
  });
});

describe("writeOutreachMessage", () => {
  const profile: OutreachProfile = {
    professional: {
      linkedinUrl: null,
      currentTitle: "Bid Director",
      company: "Acme",
      headline: null,
      location: null,
      summary: null,
      highlights: [],
      confidence: 0.8,
    },
    persona: {
      roleFamily: "Bid management",
      seniority: "VP / Director",
      department: null,
      decisionRole: "Decision maker",
      priorities: ["Win rate"],
      likelyPains: ["Too many RFPs"],
      angle: "Go/No-Go",
    },
    researchedWith: "web",
    sources: [],
  };
  const knowledge = {
    excerpts: [{ document: "Messaging", heading: "Personas > Bid", content: "AIRFP helps bid teams decide Go/No-Go.", score: 0.8 }],
    rules: "Never name Akkodis.",
    forbiddenTerms: ["Akkodis", "Acme"],
  };
  const input = {
    target,
    profile,
    channel: "LINKEDIN" as const,
    language: "fr",
    instructions: "Mention the webinar",
    sender: { name: "Simon" },
    knowledge,
    context,
  };

  it("passes knowledge, persona and instructions, and allows the prospect's own company name", async () => {
    generate.mockResolvedValueOnce(reply({ subject: null, body: "Bonjour Jane, chez Acme…" }));

    const draft = await writeOutreachMessage(input);

    expect(generate).toHaveBeenCalledTimes(1);
    const [system, user, , ctx] = generate.mock.calls[0];
    expect(system).toContain("Write in French");
    expect(system).toContain("Never name Akkodis.");
    expect(user).toContain("AIRFP helps bid teams decide Go/No-Go.");
    expect(user).toContain("Mention the webinar");
    expect(ctx.procedure).toBe("outreach.write.linkedin");
    expect(draft).toMatchObject({ body: "Bonjour Jane, chez Acme…", warnings: [], modelUsed: "GEMINI/gemini-2.5-flash" });
  });

  it("rewrites once when a confidential name or the length limit slips through", async () => {
    generate
      .mockResolvedValueOnce(reply({ body: "Comme Akkodis, " + "x".repeat(700) }))
      .mockResolvedValueOnce(reply({ body: "Comme un grand groupe d'ingénierie…" }));

    const draft = await writeOutreachMessage(input);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][1]).toMatch(/Confidential names must not appear: Akkodis/);
    expect(generate.mock.calls[1][1]).toMatch(/Too long/);
    expect(draft.warnings).toEqual([]);
  });

  it("returns the remaining problems as warnings after the rewrite", async () => {
    generate.mockResolvedValue(reply({ body: "Akkodis again" }));
    const draft = await writeOutreachMessage(input);
    expect(draft.warnings).toEqual(["Confidential names must not appear: Akkodis"]);
  });

  it("builds the retrieval query from the persona and instructions", () => {
    const query = knowledgeQuery(target, profile, "webinar");
    expect(query).toContain("VP / Director Bid management");
    expect(query).toContain("Too many RFPs");
    expect(query).toContain("focus: webinar");
  });
});
