jest.mock("@/lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  prismadb: {
    users: { findUnique: jest.fn() },
  },
}));
jest.mock("@/lib/llm/ai-router", () => {
  class AIRouterError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return { AIRouterError, aiRouter: { generateContent: jest.fn() } };
});

import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { aiRouter, AIRouterError } from "@/lib/llm/ai-router";
import { generateTemplate } from "@/actions/campaigns/templates/generate-template";

const generate = aiRouter.generateContent as jest.Mock;

const mockUser = (role: "user" | "manager" | "admin", id = "u1") => {
  (getSession as jest.Mock).mockResolvedValue({ user: { id } });
  (prismadb.users.findUnique as jest.Mock).mockResolvedValue({ id, role });
};

describe("generateTemplate scope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generate.mockResolvedValue({ text: JSON.stringify({ subject: "S", html: "<p>H</p>" }) });
  });

  it("unauthenticated throws Unauthorized and never calls the LLM", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);
    await expect(generateTemplate("p")).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it("user generates template through the AI router with their id", async () => {
    mockUser("user", "u1");
    const res = await generateTemplate("write a welcome");
    expect(res.subject).toBe("S");
    expect(res.html).toBe("<p>H</p>");
    const [, userPrompt, config, context] = generate.mock.calls[0];
    expect(userPrompt).toBe("write a welcome");
    expect(config).toMatchObject({ tier: "light", responseFormat: "json" });
    expect(context).toEqual({ userId: "u1", procedure: "campaigns.templates.generate" });
  });

  it("manager generates template", async () => {
    mockUser("manager", "m1");
    const res = await generateTemplate("p");
    expect(res.subject).toBe("S");
    expect(generate.mock.calls[0][3].userId).toBe("m1");
  });

  it("admin generates template", async () => {
    mockUser("admin", "a1");
    const res = await generateTemplate("p");
    expect(res.subject).toBe("S");
    expect(generate.mock.calls[0][3].userId).toBe("a1");
  });

  it("explains how to configure a key when no LLM provider is configured", async () => {
    mockUser("user", "u1");
    generate.mockRejectedValue(new (AIRouterError as any)("NO_PROVIDER", "none"));
    await expect(generateTemplate("p")).rejects.toThrow("No LLM API key configured");
  });
});
