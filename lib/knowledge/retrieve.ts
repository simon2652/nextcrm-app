import { prismadb } from "@/lib/prisma";
import { generateEmbedding, isEmbeddingConfigured, toVectorLiteral } from "@/inngest/lib/embedding-utils";

/**
 * Product-knowledge retrieval for AI writing.
 *
 * Like the AIRFP pipeline's prompt blocks (priority + character budget), but
 * selected per request: the chunks closest to the prospect's situation
 * (Gemini embeddings, keyword fallback), prioritised documents boosted, a
 * per-document cap for diversity, all within a character budget.
 */

export interface KnowledgeExcerpt {
  document: string;
  heading: string | null;
  content: string;
  score: number;
}

export interface RetrievedKnowledge {
  excerpts: KnowledgeExcerpt[];
  /** Confidentiality rules (Markdown) to apply to the message. */
  rules: string;
  forbiddenTerms: string[];
}

export interface RetrieveOptions {
  maxChars?: number;
  maxChunks?: number;
  perDocument?: number;
}

const PINNED_BOOST = 0.05;
const VECTOR_CANDIDATES = 40;
const MAX_RULES_CHARS = 6000;

type Candidate = { heading: string | null; content: string; title: string; pinned: boolean; score: number };

const terms = (text: string) =>
  Array.from(
    new Set(
      text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3)
    )
  );

async function vectorCandidates(query: string): Promise<Candidate[] | null> {
  if (!(await isEmbeddingConfigured())) return null;
  try {
    const vector = toVectorLiteral(await generateEmbedding(query, "RETRIEVAL_QUERY"));
    const rows = await prismadb.$queryRaw<
      Array<{ heading: string | null; content: string; title: string; pinned: boolean; similarity: number }>
    >`
      SELECT c.heading, c.content, d.title, d.pinned, 1 - (c.embedding <=> ${vector}::vector) AS similarity
      FROM "crm_Knowledge_Chunks" c
      JOIN "crm_Knowledge_Documents" d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${VECTOR_CANDIDATES}`;
    if (rows.length === 0) return null;
    return rows.map((r) => ({ ...r, score: Number(r.similarity) + (r.pinned ? PINNED_BOOST : 0) }));
  } catch (error) {
    console.warn("[KNOWLEDGE] vector search failed, using keyword matching", error);
    return null;
  }
}

async function keywordCandidates(query: string): Promise<Candidate[]> {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const chunks = await prismadb.crm_Knowledge_Chunks.findMany({
    select: { heading: true, content: true, document: { select: { title: true, pinned: true } } },
    take: 5000,
  });
  return chunks
    .map((c) => {
      const have = new Set(terms(`${c.heading ?? ""} ${c.content}`));
      const hits = wanted.filter((t) => have.has(t)).length;
      return {
        heading: c.heading,
        content: c.content,
        title: c.document.title,
        pinned: c.document.pinned,
        score: hits / wanted.length + (c.document.pinned ? PINNED_BOOST : 0),
      };
    })
    .filter((c) => c.score > (c.pinned ? PINNED_BOOST : 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, VECTOR_CANDIDATES);
}

export function selectExcerpts(candidates: Candidate[], options: RetrieveOptions = {}): KnowledgeExcerpt[] {
  const { maxChars = 14_000, maxChunks = 10, perDocument = 3 } = options;
  const perDoc = new Map<string, number>();
  const selected: KnowledgeExcerpt[] = [];
  let used = 0;
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (selected.length >= maxChunks) break;
    if ((perDoc.get(c.title) ?? 0) >= perDocument) continue;
    if (used + c.content.length > maxChars) continue;
    perDoc.set(c.title, (perDoc.get(c.title) ?? 0) + 1);
    used += c.content.length;
    selected.push({ document: c.title, heading: c.heading, content: c.content, score: c.score });
  }
  return selected;
}

export async function retrieveKnowledge(query: string, options?: RetrieveOptions): Promise<RetrievedKnowledge> {
  const ruleDocs = await prismadb.crm_Knowledge_Documents.findMany({
    where: { NOT: { forbidden_terms: { isEmpty: true } } },
    select: { content: true, forbidden_terms: true },
  });
  const candidates = (await vectorCandidates(query)) ?? (await keywordCandidates(query));
  return {
    excerpts: selectExcerpts(candidates, options),
    rules: ruleDocs.map((d) => d.content).join("\n\n").slice(0, MAX_RULES_CHARS),
    forbiddenTerms: Array.from(new Set(ruleDocs.flatMap((d) => d.forbidden_terms))),
  };
}
