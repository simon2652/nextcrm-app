import { InteractionsSection } from "@/components/crm/interactions/InteractionsSection";

interface Props {
  contactId: string;
}

// Unified feed: logged activities (calls, LinkedIn, meetings, notes) plus
// mailbox emails linked to the contact's contacts.
export async function ActivitiesSection({ contactId }: Props) {
  return <InteractionsSection entityType="contact" entityId={contactId} />;
}
