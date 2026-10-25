"use server";
import { inngest } from "@/inngest/client";
import { getApiKey } from "@/lib/api-keys";
import {
  requireRole,
  AuthenticationError,
  AuthorizationError,
} from "@/lib/authz";

/** Re-embed every CRM record and linked email (e.g. after switching to Gemini). */
export async function requestEmbeddingBackfill(): Promise<{ error?: string }> {
  try {
    await requireRole(["admin"]);
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    if (e instanceof AuthorizationError) return { error: "Forbidden" };
    throw e;
  }

  if (!(await getApiKey("GEMINI"))) {
    return { error: "Configure a Gemini API key first" };
  }

  await inngest.send({ name: "crm/backfill.requested", data: {} });
  return {};
}
