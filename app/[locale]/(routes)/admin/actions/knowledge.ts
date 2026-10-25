"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { requireRole, AuthenticationError, AuthorizationError, type AuthzUser } from "@/lib/authz";
import { MAX_KNOWLEDGE_CHARS, saveKnowledgeDocument } from "@/lib/knowledge/store";
import { confidentialityMarkdown, parseConfidentialityJson } from "@/lib/knowledge/confidentiality";

type Result<T = object> = T | { error: string };

async function requireAdmin(): Promise<AuthzUser | { error: string }> {
  try {
    return await requireRole(["admin"]);
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    if (e instanceof AuthorizationError) return { error: "Forbidden" };
    throw e;
  }
}

export interface KnowledgeDocumentRow {
  id: string;
  source: string;
  title: string;
  pinned: boolean;
  status: "PENDING" | "READY" | "FAILED";
  error: string | null;
  chunkCount: number;
  forbiddenCount: number;
  chars: number;
  updatedAt: string;
}

export async function listKnowledgeDocuments(): Promise<Result<{ documents: KnowledgeDocumentRow[] }>> {
  const admin = await requireAdmin();
  if ("error" in admin) return admin;
  const docs = await prismadb.crm_Knowledge_Documents.findMany({
    orderBy: { source: "asc" },
    select: {
      id: true,
      source: true,
      title: true,
      pinned: true,
      status: true,
      error: true,
      chunk_count: true,
      forbidden_terms: true,
      content: true,
      updatedAt: true,
    },
  });
  return {
    documents: docs.map((d) => ({
      id: d.id,
      source: d.source,
      title: d.title,
      pinned: d.pinned,
      status: d.status,
      error: d.error,
      chunkCount: d.chunk_count,
      forbiddenCount: d.forbidden_terms.length,
      chars: d.content.length,
      updatedAt: d.updatedAt.toISOString(),
    })),
  };
}

const fileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().max(MAX_KNOWLEDGE_CHARS, "File too large"),
});

function titleFor(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return (heading || path.split("/").pop() || path).slice(0, 200);
}

/**
 * Add or update one knowledge file (.md / .txt, or a confidentiality .json).
 * Files are sent one by one from the browser to stay under the server action
 * body limit; unchanged files are not re-indexed.
 */
export async function saveKnowledgeFile(
  input: z.infer<typeof fileSchema>
): Promise<Result<{ id: string; changed: boolean; kind: "knowledge" | "confidentiality" }>> {
  const admin = await requireAdmin();
  if ("error" in admin) return admin;
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid file" };
  const path = parsed.data.path.replace(/\\/g, "/");
  const content = parsed.data.content.replace(/^﻿/, "");

  let saved: { id: string; changed: boolean };
  let kind: "knowledge" | "confidentiality" = "knowledge";
  if (/\.json$/i.test(path)) {
    const list = parseConfidentialityJson(content);
    if (!list) return { error: "Only confidentiality lists (forbidden_terms / termes_interdits) are accepted as JSON" };
    kind = "confidentiality";
    saved = await saveKnowledgeDocument({
      source: path,
      title: `Confidentiality — ${path.split("/").pop()}`,
      content: confidentialityMarkdown(list),
      forbiddenTerms: list.forbidden,
      userId: admin.id,
    });
  } else if (/\.(md|markdown|txt)$/i.test(path)) {
    if (!content.trim()) return { error: "Empty file" };
    saved = await saveKnowledgeDocument({ source: path, title: titleFor(path, content), content, userId: admin.id });
  } else {
    return { error: "Unsupported file type (use .md, .txt or a confidentiality .json)" };
  }

  if (saved.changed) {
    await inngest.send({ name: "knowledge/document.saved", data: { documentId: saved.id } });
  }
  revalidatePath("/admin/knowledge");
  return { ...saved, kind };
}

export async function setKnowledgePinned(id: string, pinned: boolean): Promise<Result> {
  const admin = await requireAdmin();
  if ("error" in admin) return admin;
  await prismadb.crm_Knowledge_Documents.update({ where: { id }, data: { pinned } });
  revalidatePath("/admin/knowledge");
  return {};
}

export async function deleteKnowledgeDocument(id: string): Promise<Result> {
  const admin = await requireAdmin();
  if ("error" in admin) return admin;
  await prismadb.crm_Knowledge_Documents.delete({ where: { id } });
  revalidatePath("/admin/knowledge");
  return {};
}

/** Re-chunk and re-embed every document (e.g. after adding the Gemini key). */
export async function reindexKnowledge(): Promise<Result<{ count: number }>> {
  const admin = await requireAdmin();
  if ("error" in admin) return admin;
  const docs = await prismadb.crm_Knowledge_Documents.findMany({ select: { id: true } });
  if (docs.length > 0) {
    await prismadb.crm_Knowledge_Documents.updateMany({ data: { status: "PENDING", error: null } });
    await inngest.send(docs.map((d) => ({ name: "knowledge/document.saved", data: { documentId: d.id } })));
  }
  revalidatePath("/admin/knowledge");
  return { count: docs.length };
}
