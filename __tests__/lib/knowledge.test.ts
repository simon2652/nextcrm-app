/**
 * Product knowledge: Markdown chunking, confidentiality list and excerpt selection.
 */
jest.mock("@/lib/prisma", () => ({ prismadb: {} }));
jest.mock("@/inngest/lib/embedding-utils", () => ({}));

import { chunkMarkdown } from "@/lib/knowledge/chunk";
import {
  confidentialityMarkdown,
  findForbiddenTerms,
  parseConfidentialityJson,
} from "@/lib/knowledge/confidentiality";
import { selectExcerpts } from "@/lib/knowledge/retrieve";

describe("chunkMarkdown", () => {
  it("keeps the heading path and splits long sections on paragraphs", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} `.padEnd(400, "x")).join("\n\n");
    const md = `# Messaging\n\nIntro text that is long enough to stand alone. `.padEnd(260, "y") +
      `\n\n## Personas\n\n### CRO\n\n${long}\n\n\`\`\`\n# not a heading\n\`\`\``;

    const chunks = chunkMarkdown(md, 1000);

    expect(chunks[0]).toMatchObject({ heading: "Messaging" });
    const cro = chunks.filter((c) => c.heading === "Messaging > Personas > CRO");
    expect(cro.length).toBeGreaterThan(1);
    expect(cro.every((c) => c.content.length <= 1000)).toBe(true);
    expect(chunks.some((c) => c.heading?.includes("not a heading"))).toBe(false);
  });

  it("folds tiny sections into the previous chunk", () => {
    const chunks = chunkMarkdown(`# A\n\n${"a".repeat(300)}\n\n## B\n\nshort`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("B\nshort");
  });
});

describe("confidentiality", () => {
  const raw = JSON.stringify({
    termes_interdits: ["Akkodis", "Société Générale"],
    noms_autorises: ["AIRFP"],
    descripteurs_generiques: ["un grand compte du BTP"],
  });

  it("parses the pipeline's confidentialite.json shape", () => {
    const list = parseConfidentialityJson(raw)!;
    expect(list.forbidden).toEqual(["Akkodis", "Société Générale"]);
    expect(confidentialityMarkdown(list)).toContain("- un grand compte du BTP");
    expect(parseConfidentialityJson('{"other": 1}')).toBeNull();
    expect(parseConfidentialityJson("not json")).toBeNull();
  });

  it("finds whole-word names, ignoring case and accents, except allowed ones", () => {
    const terms = ["Akkodis", "Société Générale", "Orange"];
    expect(findForbiddenTerms("Comme chez AKKODIS et la societe generale…", terms)).toEqual([
      "Akkodis",
      "Société Générale",
    ]);
    expect(findForbiddenTerms("Des oranges pressées", terms)).toEqual([]);
    expect(findForbiddenTerms("Bonjour Akkodis", terms, ["akkodis"])).toEqual([]);
  });
});

describe("selectExcerpts", () => {
  const c = (title: string, score: number, size = 100) => ({
    title,
    heading: null,
    content: "x".repeat(size),
    pinned: false,
    score,
  });

  it("ranks by score, caps per document and respects the character budget", () => {
    const picked = selectExcerpts(
      [c("A", 0.9), c("A", 0.8), c("A", 0.7), c("B", 0.6, 900), c("C", 0.5)],
      { perDocument: 2, maxChars: 500 }
    );
    expect(picked.map((p) => [p.document, p.score])).toEqual([
      ["A", 0.9],
      ["A", 0.8],
      ["C", 0.5],
    ]);
  });
});
