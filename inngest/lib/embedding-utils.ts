import { createHash } from "crypto";
import { getApiKey } from "@/lib/api-keys";

/** Gemini embedding model; MRL lets it emit the 1536 dims our pgvector columns use. */
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 1536;
/** gemini-embedding-001 accepts ~2048 input tokens (~4 chars per token). */
export const MAX_EMBEDDING_CHARS = 2000 * 4;

export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export class EmbeddingKeyMissingError extends Error {
  constructor() {
    super("No Gemini API key configured: embeddings are disabled");
    this.name = "EmbeddingKeyMissingError";
  }
}

/**
 * Concatenate non-null text fields into a single embedding string.
 * Filters out null/undefined/empty values before joining.
 */
export function buildEmbeddingText(fields: (string | null | undefined)[]): string {
  return fields
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .join(" ");
}

/**
 * Compute a SHA-256 hash of the text for change detection.
 * The model id is part of the hash, so switching models re-embeds every record.
 */
export function computeContentHash(text: string): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}:${text}`).digest("hex");
}

/** True when a Gemini key is available (ENV or system-wide) for background embedding jobs. */
export async function isEmbeddingConfigured(): Promise<boolean> {
  return (await getApiKey("GEMINI")) !== null;
}

/**
 * Generate an embedding vector via Gemini gemini-embedding-001.
 * Returns an L2-normalised float array of 1536 dimensions (reduced MRL
 * outputs are not normalised by the API).
 */
export async function generateEmbedding(
  text: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
): Promise<number[]> {
  const apiKey = await getApiKey("GEMINI");
  if (!apiKey) throw new EmbeddingKeyMissingError();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, MAX_EMBEDDING_CHARS) }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Gemini embedding failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Gemini embedding returned ${values?.length ?? 0} dimensions`);
  }

  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

/**
 * Format a number[] embedding as a pgvector literal string.
 * Example: [0.1, 0.2, ...] → '[0.1,0.2,...]'
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
