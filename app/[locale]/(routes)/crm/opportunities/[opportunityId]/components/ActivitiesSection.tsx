import { InteractionsSection } from "@/components/crm/interactions/InteractionsSection";

interface Props {
  opportunityId: string;
}

// Unified feed: logged activities (calls, LinkedIn, meetings, notes) plus
// mailbox emails linked to the opportunity's contacts.
export async function ActivitiesSection({ opportunityId }: Props) {
  return <InteractionsSection entityType="opportunity" entityId={opportunityId} />;
}
