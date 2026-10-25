import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getInteractions } from "@/actions/crm/interactions/get-interactions";
import type { InteractionEntityType } from "@/actions/crm/interactions/get-interactions";
import { InteractionsTimeline } from "./InteractionsTimeline";

interface Props {
  entityType: InteractionEntityType;
  entityId: string;
}

/** Server wrapper: first page of the feed, the viewer's mailbox and the contacts' addresses. */
export async function InteractionsSection({ entityType, entityId }: Props) {
  const session = await getSession();
  const [initialData, emailAccount, contacts] = await Promise.all([
    getInteractions(entityType, entityId),
    session?.user?.id
      ? prismadb.emailAccount.findFirst({
          where: { userId: session.user.id },
          select: { id: true },
        })
      : null,
    entityType === "contact"
      ? prismadb.crm_Contacts.findMany({ where: { id: entityId }, select: { email: true } })
      : prismadb.crm_Opportunities
          .findUnique({ where: { id: entityId }, select: { contact: true } })
          .then((opportunity) =>
            prismadb.crm_Contacts.findMany({
              where: {
                OR: [
                  { opportunities: { some: { opportunity_id: entityId } } },
                  ...(opportunity?.contact ? [{ id: opportunity.contact }] : []),
                ],
              },
              select: { email: true },
            })
          ),
  ]);

  const defaultEmailTo = Array.from(new Set(contacts.map((c) => c.email).filter(Boolean))).join(", ");

  return (
    <InteractionsTimeline
      entityType={entityType}
      entityId={entityId}
      initialData={initialData}
      emailAccountId={emailAccount?.id ?? null}
      defaultEmailTo={defaultEmailTo}
    />
  );
}
