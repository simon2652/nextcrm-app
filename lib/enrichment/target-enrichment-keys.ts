import { hasAnyLlmKey } from "@/lib/llm/ai-router";

/**
 * Keys the queued target-enrichment job (inngest/functions/enrich-target.ts)
 * needs: any LLM provider through the key tiers (the AI router falls back
 * across them), and E2B from the environment only (the sandboxed browser).
 * Returns the first missing one, or null when the job can run.
 */
export async function missingTargetEnrichmentKey(
  userId: string
): Promise<"LLM" | "E2B_API_KEY" | null> {
  if (!(await hasAnyLlmKey(userId))) return "LLM";
  if (!process.env.E2B_API_KEY) return "E2B_API_KEY";
  return null;
}
