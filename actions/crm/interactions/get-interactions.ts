"use server";
import { prismadb } from "@/lib/prisma";
import {
  requireAuthenticated,
  assertCanReadActivityForEntity,
  AuthenticationError,
  AuthorizationError,
} from "@/lib/authz";
import type { ActivityWithLinks } from "@/actions/crm/activities/get-activities-by-entity";

const PAGE_SIZE = 25;
// Interactions per deal/contact are small; headers are merged in memory and
// only the requested page is hydrated with bodies.
const MAX_ITEMS = 2000;

export type InteractionEntityType = "opportunity" | "contact";
export type InteractionType = ActivityWithLinks["type"];

export type InteractionEmail = {
  id: string;
  folder: "INBOX" | "SENT";
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  bodyText: string | null;
};

export type Interaction =
  | { kind: "activity"; id: string; date: Date; activity: ActivityWithLinks }
  | { kind: "email"; id: string; date: Date; email: InteractionEmail };

export type InteractionCursor = { date: string; id: string };

export type InteractionSummary = {
  lastContactAt: Date | null;
  emails: number;
  linkedin: number;
  calls: number;
  meetings: number;
  nextScheduled: { title: string; date: Date } | null;
};

export type InteractionsPage = {
  data: Interaction[];
  nextCursor: InteractionCursor | null;
  summary: InteractionSummary;
};

const EMPTY_PAGE: InteractionsPage = {
  data: [],
  nextCursor: null,
  summary: { lastContactAt: null, emails: 0, linkedin: 0, calls: 0, meetings: 0, nextScheduled: null },
};

type Head = { kind: "activity" | "email"; id: string; date: Date };

const byDateDesc = (a: Head, b: Head) =>
  b.date.getTime() - a.date.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

async function resolveContactIds(entityType: InteractionEntityType, entityId: string) {
  if (entityType === "contact") return [entityId];
  const [opportunity, links] = await Promise.all([
    prismadb.crm_Opportunities.findUnique({ where: { id: entityId }, select: { contact: true } }),
    prismadb.contactsToOpportunities.findMany({
      where: { opportunity_id: entityId },
      select: { contact_id: true },
    }),
  ]);
  const ids = new Set(links.map((l) => l.contact_id));
  if (opportunity?.contact) ids.add(opportunity.contact);
  return Array.from(ids);
}

/**
 * Chronological feed of every touchpoint with a deal or contact: logged
 * activities (calls, LinkedIn messages, meetings, notes, manual emails) on the
 * record or its contacts, plus synced/sent emails linked to those contacts.
 */
export const getInteractions = async (
  entityType: InteractionEntityType,
  entityId: string,
  options: { cursor?: InteractionCursor; types?: InteractionType[] } = {}
): Promise<InteractionsPage> => {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) return EMPTY_PAGE;
    throw e;
  }
  try {
    await assertCanReadActivityForEntity(user, entityType, entityId);
  } catch (e) {
    if (e instanceof AuthorizationError) return EMPTY_PAGE;
    throw e;
  }

  try {
    const contactIds = await resolveContactIds(entityType, entityId);

    const links = await prismadb.crm_ActivityLinks.findMany({
      where: {
        OR: [
          { entityType, entityId },
          ...(contactIds.length > 0
            ? [{ entityType: "contact", entityId: { in: contactIds } }]
            : []),
        ],
      },
      select: { activityId: true },
      take: MAX_ITEMS,
    });

    const [activityHeads, emailHeads] = await Promise.all([
      prismadb.crm_Activities.findMany({
        where: { id: { in: Array.from(new Set(links.map((l) => l.activityId))) }, deletedAt: null },
        select: { id: true, type: true, date: true, status: true, title: true },
        orderBy: { date: "desc" },
        take: MAX_ITEMS,
      }),
      contactIds.length > 0
        ? prismadb.email.findMany({
            where: {
              isDeleted: false,
              contacts: { some: { contactId: { in: contactIds } } },
              // Mailboxes are personal: plain users only see their own messages.
              ...(user.role === "admin" || user.role === "manager" ? {} : { userId: user.id }),
            },
            select: { id: true, sentAt: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: MAX_ITEMS,
          })
        : Promise.resolve([]),
    ]);

    // Summary over the unfiltered feed.
    const now = new Date();
    const touchpoints = activityHeads.filter((a) => a.status === "completed" && a.type !== "note");
    const lastActivityAt = touchpoints.reduce<Date | null>(
      (max, a) => (a.date <= now && (!max || a.date > max) ? a.date : max),
      null
    );
    const lastEmailAt = emailHeads.reduce<Date | null>((max, e) => {
      const d = e.sentAt ?? e.createdAt;
      return !max || d > max ? d : max;
    }, null);
    const next = activityHeads
      .filter((a) => a.status === "scheduled" && a.date >= now)
      .sort((a, b) => a.date.getTime() - b.date.getTime())[0];
    const count = (...types: InteractionType[]) =>
      touchpoints.filter((a) => types.includes(a.type)).length;

    const summary: InteractionSummary = {
      lastContactAt:
        lastActivityAt && lastEmailAt
          ? (lastActivityAt > lastEmailAt ? lastActivityAt : lastEmailAt)
          : lastActivityAt ?? lastEmailAt,
      emails: count("email") + emailHeads.length,
      linkedin: count("linkedin"),
      calls: count("call"),
      meetings: count("meeting", "visit"),
      nextScheduled: next ? { title: next.title, date: next.date } : null,
    };

    const types = options.types?.length ? options.types : null;
    const heads: Head[] = [
      ...activityHeads
        .filter((a) => !types || types.includes(a.type))
        .map((a) => ({ kind: "activity" as const, id: a.id, date: a.date })),
      ...(!types || types.includes("email")
        ? emailHeads.map((e) => ({ kind: "email" as const, id: e.id, date: e.sentAt ?? e.createdAt }))
        : []),
    ].sort(byDateDesc);

    const cursor = options.cursor;
    const remaining = cursor
      ? heads.filter((h) => byDateDesc(h, { kind: "activity", id: cursor.id, date: new Date(cursor.date) }) > 0)
      : heads;
    const page = remaining.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const nextCursor =
      remaining.length > PAGE_SIZE && last ? { date: last.date.toISOString(), id: last.id } : null;

    const pageActivityIds = page.filter((h) => h.kind === "activity").map((h) => h.id);
    const pageEmailIds = page.filter((h) => h.kind === "email").map((h) => h.id);

    const [activities, emails] = await Promise.all([
      pageActivityIds.length > 0
        ? prismadb.crm_Activities.findMany({
            where: { id: { in: pageActivityIds } },
            include: {
              created_by_user: { select: { id: true, name: true, avatar: true } },
              links: { select: { id: true, entityType: true, entityId: true } },
            },
          })
        : Promise.resolve([]),
      pageEmailIds.length > 0
        ? prismadb.email.findMany({
            where: { id: { in: pageEmailIds } },
            select: {
              id: true,
              folder: true,
              subject: true,
              fromName: true,
              fromEmail: true,
              toRecipients: true,
              bodyText: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const activityById = new Map(activities.map((a) => [a.id, a as unknown as ActivityWithLinks]));
    const emailById = new Map(emails.map((e) => [e.id, e]));

    const data = page.flatMap((h): Interaction[] => {
      if (h.kind === "activity") {
        const activity = activityById.get(h.id);
        return activity ? [{ kind: "activity", id: h.id, date: h.date, activity }] : [];
      }
      const email = emailById.get(h.id);
      if (!email) return [];
      return [
        {
          kind: "email",
          id: h.id,
          date: h.date,
          email: {
            id: email.id,
            folder: email.folder,
            subject: email.subject,
            fromName: email.fromName,
            fromEmail: email.fromEmail,
            to: (email.toRecipients as { email?: string }[])
              .map((r) => r.email)
              .filter((e): e is string => typeof e === "string"),
            bodyText: email.bodyText,
          },
        },
      ];
    });

    return { data, nextCursor, summary };
  } catch (error) {
    console.error("getInteractions error:", error);
    return EMPTY_PAGE;
  }
};
