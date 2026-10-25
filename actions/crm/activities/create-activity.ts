"use server";
import { z } from "zod";
import {
  requireAuthenticated,
  assertCanReadActivityForEntity,
  AuthenticationError,
  AuthorizationError,
} from "@/lib/authz";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { emitCalendarOutbound } from "@/lib/crm/calendar/outbound-emit";

const ENTITY_SLUGS: Record<string, string> = {
  account: "accounts",
  contact: "contacts",
  lead: "leads",
  opportunity: "opportunities",
  contract: "contracts",
};

const createActivitySchema = z.object({
  type: z.enum(["call", "meeting", "note", "email", "visit", "linkedin"]),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional(),
  date: z.coerce.date(),
  duration: z.number().int().positive().optional(),
  outcome: z.string().max(2_000).optional(),
  status: z.enum(["scheduled", "completed", "cancelled"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  links: z.array(z.object({ entityType: z.string(), entityId: z.string().uuid() })),
});

export const createActivity = async (data: z.input<typeof createActivitySchema>) => {
  const parsed = createActivitySchema.safeParse(data);
  if (!parsed.success) return { error: "Invalid activity" };
  const input = parsed.data;

  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    throw e;
  }
  try {
    // Only log activities against records the caller can see.
    for (const link of input.links) {
      await assertCanReadActivityForEntity(user, link.entityType, link.entityId);
    }
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "Forbidden" };
    throw e;
  }

  try {
    const activity = await prismadb.$transaction(async (tx) => {
      const created = await (tx as any).crm_Activities.create({
        data: {
          type: input.type,
          title: input.title,
          description: input.description,
          date: input.date,
          duration: input.duration,
          outcome: input.outcome,
          status: input.status,
          metadata: input.metadata,
          createdBy: user.id,
        },
      });

      if (input.links.length > 0) {
        await (tx as any).crm_ActivityLinks.createMany({
          data: input.links.map((link) => ({
            activityId: created.id,
            entityType: link.entityType,
            entityId: link.entityId,
          })),
        });
      }

      // A completed touchpoint refreshes "last activity" on the linked deal / contact.
      if (input.status === "completed") {
        const ids = (type: string) =>
          input.links.filter((l) => l.entityType === type).map((l) => l.entityId);
        const opportunityIds = ids("opportunity");
        const contactIds = ids("contact");
        if (opportunityIds.length > 0) {
          await tx.crm_Opportunities.updateMany({
            where: {
              id: { in: opportunityIds },
              OR: [{ last_activity: null }, { last_activity: { lt: input.date } }],
            },
            data: { last_activity: input.date, last_activity_by: user.id },
          });
        }
        if (contactIds.length > 0) {
          await tx.crm_Contacts.updateMany({
            where: {
              id: { in: contactIds },
              OR: [{ last_activity: null }, { last_activity: { lt: input.date } }],
            },
            data: { last_activity: input.date },
          });
        }
      }

      return created;
    });

    if (input.type === "meeting") {
      await emitCalendarOutbound(activity.id, "upsert");
    }

    const fullActivity = await (prismadb as any).crm_Activities.findUnique({
      where: { id: activity.id },
      include: {
        created_by_user: { select: { id: true, name: true, avatar: true } },
        links: { select: { id: true, entityType: true, entityId: true } },
      },
    });

    for (const link of input.links) {
      revalidatePath(
        `/[locale]/(routes)/crm/${ENTITY_SLUGS[link.entityType] ?? `${link.entityType}s`}/${link.entityId}`,
        "page"
      );
    }

    return { data: fullActivity };
  } catch (error) {
    console.error("createActivity error:", error);
    return { error: "Failed to create activity" };
  }
};
