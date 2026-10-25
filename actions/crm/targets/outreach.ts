"use server";
import { z } from "zod";
import { prismadb } from "@/lib/prisma";
import { inngest } from "@/inngest/client";
import { hasAnyLlmKey } from "@/lib/llm/ai-router";
import { OUTREACH_BULK_MAX, OUTREACH_LANGUAGES } from "@/lib/outreach/constants";
import type { OutreachProfile } from "@/lib/outreach/profile";
import {
  requireAuthenticated,
  assertCanReadTarget,
  assertCanWriteTarget,
  assertCanReadTargetList,
  filterAuthorizedTargetIds,
  targetReadScopeWhere,
  AuthenticationError,
  AuthorizationError,
  type AuthzUser,
} from "@/lib/authz";

type Result<T = object> = T | { error: string };

async function currentUser(): Promise<AuthzUser | { error: string }> {
  try {
    return await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    throw e;
  }
}

const requestSchema = z.object({
  targetIds: z.array(z.string().uuid()).min(1).max(OUTREACH_BULK_MAX),
  channel: z.enum(["EMAIL", "LINKEDIN", "WHATSAPP"]),
  language: z.string().refine((l) => l in OUTREACH_LANGUAGES, "Unsupported language"),
  instructions: z.string().trim().max(2000).optional(),
  refreshProfile: z.boolean().optional(),
});

/** Queue one message per target; generation runs in the background (Inngest). */
export async function requestOutreach(
  input: z.input<typeof requestSchema>
): Promise<Result<{ queued: number; skipped: number }>> {
  const user = await currentUser();
  if ("error" in user) return user;
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
  const { targetIds, channel, language, instructions, refreshProfile } = parsed.data;

  if (!(await hasAnyLlmKey(user.id))) {
    return { error: "No LLM API key configured (Gemini or OpenRouter). Add one in Profile → LLMs." };
  }
  const allowed = await filterAuthorizedTargetIds(user, Array.from(new Set(targetIds)));
  if (allowed.length === 0) return { error: "Forbidden" };

  const rows = await prismadb.crm_Target_Outreach.createManyAndReturn({
    data: allowed.map((target_id) => ({
      target_id,
      channel,
      language,
      instructions: instructions || null,
      created_by: user.id,
    })),
    select: { id: true },
  });
  await inngest.send(
    rows.map((r) => ({ name: "crm/target.outreach.requested", data: { outreachId: r.id, refreshProfile: !!refreshProfile } }))
  );
  return { queued: rows.length, skipped: targetIds.length - rows.length };
}

export interface OutreachMessage {
  id: string;
  channel: "EMAIL" | "LINKEDIN" | "WHATSAPP";
  language: string;
  instructions: string | null;
  status: "PENDING" | "RESEARCHING" | "WRITING" | "READY" | "SENT" | "FAILED";
  subject: string | null;
  body: string | null;
  warnings: string[];
  knowledgeSources: Array<{ document: string; heading: string | null }>;
  modelUsed: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export async function getTargetOutreach(
  targetId: string
): Promise<Result<{ profile: OutreachProfile | null; profileAt: string | null; messages: OutreachMessage[] }>> {
  const user = await currentUser();
  if ("error" in user) return user;
  try {
    await assertCanReadTarget(user, targetId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "Forbidden" };
    throw e;
  }
  const target = await prismadb.crm_Targets.findUnique({
    where: { id: targetId },
    select: {
      outreach_profile: true,
      outreach_profile_at: true,
      outreach_messages: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!target) return { error: "Target not found" };
  return {
    profile: (target.outreach_profile as unknown as OutreachProfile) ?? null,
    profileAt: target.outreach_profile_at?.toISOString() ?? null,
    messages: target.outreach_messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      language: m.language,
      instructions: m.instructions,
      status: m.status,
      subject: m.subject,
      body: m.body,
      warnings: m.warnings,
      knowledgeSources: (m.knowledge_sources as OutreachMessage["knowledgeSources"]) ?? [],
      modelUsed: m.model_used,
      error: m.error,
      sentAt: m.sent_at?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

async function authorizeMessage(user: AuthzUser, id: string): Promise<{ id: string; status: string } | null> {
  const message = await prismadb.crm_Target_Outreach.findUnique({
    where: { id },
    select: { id: true, status: true, target_id: true },
  });
  if (!message) return null;
  try {
    await assertCanWriteTarget(user, message.target_id);
  } catch (e) {
    if (e instanceof AuthorizationError) return null;
    throw e;
  }
  return message;
}

const editSchema = z.object({
  subject: z.string().trim().max(300).nullable(),
  body: z.string().trim().min(1).max(5000),
});

export async function updateOutreachMessage(id: string, input: z.input<typeof editSchema>): Promise<Result> {
  const user = await currentUser();
  if ("error" in user) return user;
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid message" };
  const message = await authorizeMessage(user, id);
  if (!message) return { error: "Not found" };
  if (message.status !== "READY" && message.status !== "SENT") return { error: "The message is still being generated" };
  await prismadb.crm_Target_Outreach.update({ where: { id }, data: parsed.data });
  return {};
}

/** Mark a message as sent (or back to draft); the sent date is the interaction log. */
export async function markOutreachSent(id: string, sent: boolean): Promise<Result> {
  const user = await currentUser();
  if ("error" in user) return user;
  const message = await authorizeMessage(user, id);
  if (!message) return { error: "Not found" };
  if (message.status !== "READY" && message.status !== "SENT") return { error: "The message is not ready" };
  await prismadb.crm_Target_Outreach.update({
    where: { id },
    data: sent ? { status: "SENT", sent_at: new Date() } : { status: "READY", sent_at: null },
  });
  return {};
}

export async function deleteOutreachMessage(id: string): Promise<Result> {
  const user = await currentUser();
  if ("error" in user) return user;
  const message = await authorizeMessage(user, id);
  if (!message) return { error: "Not found" };
  await prismadb.crm_Target_Outreach.delete({ where: { id } });
  return {};
}

export interface OutreachQueuePosition {
  listId: string | null;
  listName: string | null;
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  /** Next target after this one with no message marked as sent yet. */
  nextUncontactedId: string | null;
}

/**
 * Position of a target in the one-by-one processing queue: a target list when
 * given, otherwise all the user's targets, newest import first.
 */
export async function getOutreachQueuePosition(
  targetId: string,
  listId?: string | null
): Promise<Result<OutreachQueuePosition>> {
  const user = await currentUser();
  if ("error" in user) return user;

  let listName: string | null = null;
  if (listId) {
    try {
      await assertCanReadTargetList(user, listId);
    } catch (e) {
      if (e instanceof AuthorizationError) return { error: "Forbidden" };
      throw e;
    }
    listName = (await prismadb.crm_TargetLists.findUnique({ where: { id: listId }, select: { name: true } }))?.name ?? null;
  }

  const queue = await prismadb.crm_Targets.findMany({
    where: {
      ...targetReadScopeWhere(user),
      ...(listId && { target_lists: { some: { target_list_id: listId } } }),
    },
    orderBy: listId ? [{ last_name: "asc" }, { id: "asc" }] : [{ created_on: "desc" }, { id: "asc" }],
    select: { id: true, outreach_messages: { where: { status: "SENT" }, select: { id: true }, take: 1 } },
    take: 5000,
  });
  const index = queue.findIndex((t) => t.id === targetId);
  if (index === -1) return { error: "Target is not in this queue" };

  const after = queue.slice(index + 1);
  return {
    listId: listId ?? null,
    listName,
    index: index + 1,
    total: queue.length,
    prevId: queue[index - 1]?.id ?? null,
    nextId: queue[index + 1]?.id ?? null,
    nextUncontactedId: after.find((t) => t.outreach_messages.length === 0)?.id ?? null,
  };
}
