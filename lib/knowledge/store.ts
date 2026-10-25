import { createHash } from "crypto";
import { prismadb } from "@/lib/prisma";
import {
  generateEmbedding,
  isEmbeddingConfigured,
  toVectorLiteral,
} from "@/inngest/lib/embedding-utils";
import { chunkMarkdown } from "./chunk";

/** Largest knowledge file accepted (characters). */
export const MAX_KNOWLEDGE_CHARS = 500_000;

export interface KnowledgeDocumentInput {
  /** Stable key, e.g. the file's relative path; re-saving the same source updates it. */
  source: string;
  title: string;
  content: string;
  pinned?: boolean;
  forbiddenTerms?: string[];
  userId?: string;
}

/**
 * Create or update a knowledge document. Returns `changed: false` when the
 * content is identical to what is already indexed (no re-embedding needed).
 */
export async function saveKnowledgeDocument(
  input: KnowledgeDocumentInput
): Promise<{ id: string; changed: boolean }> {
  const forbidden_terms = input.forbiddenTerms ?? [];
  const content_hash = createHash("sha256")
    .update(`${input.content}\u0000${forbidden_terms.join("\u0000")}`)
    .digest("hex");

  const existing = await prismadb.crm_Knowledge_Documents.findUnique({
    where: { source: input.source },
    select: { id: true, content_hash: true, status: true },
  });
  if (existing && existing.content_hash === content_hash && existing.status === "READY") {
    await prismadb.crm_Knowledge_Documents.update({
      where: { id: existing.id },
      data: { title: input.title, ...(input.pinned !== undefined && { pinned: input.pinned }) },
    });
    return { id: existing.id, changed: false };
  }

  const data = {
    title: input.title,
    content: input.content,
    content_hash,
    forbidden_terms,
    status: "PENDING" as const,
    error: null,
    ...(input.pinned !== undefined && { pinned: input.pinned }),
  };
  const doc = await prismadb.crm_Knowledge_Documents.upsert({
    where: { source: input.source },
    create: { source: input.source, created_by: input.userId, ...data },
    update: data,
    select: { id: true },
  });
  return { id: doc.id, changed: true };
}

/**
 * Replace a document's chunks (stored without embeddings yet). Confidentiality
 * lists are not chunked: they are applied as rules, not retrieved. Returns the
 * chunk ids to embed, in order, and whether embedding is possible (Gemini key);
 * without it retrieval falls back to keyword matching.
 */
export async function chunkKnowledgeDocument(
  documentId: string
): Promise<{ chunkIds: string[]; embed: boolean }> {
  const doc = await prismadb.crm_Knowledge_Documents.findUnique({
    where: { id: documentId },
    select: { id: true, content: true, forbidden_terms: true },
  });
  if (!doc) return { chunkIds: [], embed: false };

  const chunks = doc.forbidden_terms.length > 0 ? [] : chunkMarkdown(doc.content);
  const embed = chunks.length > 0 && (await isEmbeddingConfigured());

  const chunkIds = await prismadb.$transaction(async (tx) => {
    await tx.crm_Knowledge_Chunks.deleteMany({ where: { document_id: doc.id } });
    const created = chunks.length
      ? await tx.crm_Knowledge_Chunks.createManyAndReturn({
          data: chunks.map((c, i) => ({ document_id: doc.id, chunk_index: i, heading: c.heading, content: c.content })),
          select: { id: true, chunk_index: true },
        })
      : [];
    await tx.crm_Knowledge_Documents.update({
      where: { id: doc.id },
      data: { chunk_count: chunks.length, error: null, ...(!embed && { status: "READY" as const }) },
    });
    return created.sort((a, b) => a.chunk_index - b.chunk_index).map((c) => c.id);
  });
  return { chunkIds, embed };
}

/** Embed a batch of chunks with Gemini (RETRIEVAL_DOCUMENT); a 429 throws so the step is retried. */
export async function embedKnowledgeChunks(chunkIds: string[]): Promise<number> {
  const chunks = await prismadb.crm_Knowledge_Chunks.findMany({
    where: { id: { in: chunkIds } },
    select: { id: true, heading: true, content: true, document: { select: { title: true } } },
  });
  for (const chunk of chunks) {
    const vector = toVectorLiteral(
      await generateEmbedding(
        `${chunk.document.title}${chunk.heading ? ` — ${chunk.heading}` : ""}

${chunk.content}`,
        "RETRIEVAL_DOCUMENT"
      )
    );
    await prismadb.$executeRaw`
      UPDATE "crm_Knowledge_Chunks" SET "embedding" = ${vector}::vector WHERE "id" = ${chunk.id}::uuid`;
  }
  return chunks.length;
}

export async function markKnowledgeReady(documentId: string): Promise<void> {
  await prismadb.crm_Knowledge_Documents.update({ where: { id: documentId }, data: { status: "READY", error: null } });
}
