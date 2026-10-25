import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { chunkKnowledgeDocument, embedKnowledgeChunks, markKnowledgeReady } from "@/lib/knowledge/store";

/** Chunks embedded per step: short steps, and a rate-limited batch is retried alone. */
const EMBED_BATCH = 8;

/** Chunk + embed one product-knowledge document. */
export const indexKnowledge = inngest.createFunction(
  {
    id: "knowledge-index-document",
    name: "Index Knowledge Document",
    triggers: [{ event: "knowledge/document.saved" }],
    // Gemini's free embedding quota is low (tokens per minute): one document
    // at a time, and generous retries (with backoff) on 429s.
    retries: 8,
    concurrency: { limit: 1 },
    onFailure: async ({ event, error }) => {
      const { documentId } = event.data.event.data as { documentId: string };
      await prismadb.crm_Knowledge_Documents.updateMany({
        where: { id: documentId },
        data: { status: "FAILED", error: error.message.slice(0, 500) },
      });
    },
  },
  async ({ event, step }) => {
    const { documentId } = event.data as { documentId: string };

    const { chunkIds, embed } = await step.run("chunk", () => chunkKnowledgeDocument(documentId));
    if (!embed) return { documentId, chunks: chunkIds.length, embedded: false };

    for (let i = 0; i < chunkIds.length; i += EMBED_BATCH) {
      await step.run(`embed-${i / EMBED_BATCH}`, () => embedKnowledgeChunks(chunkIds.slice(i, i + EMBED_BATCH)));
    }
    await step.run("ready", () => markKnowledgeReady(documentId));
    return { documentId, chunks: chunkIds.length, embedded: true };
  }
);
