-- AlterEnum: LinkedIn messages are logged as activities alongside calls and emails.
ALTER TYPE "crm_Activity_Type" ADD VALUE IF NOT EXISTS 'linkedin';

-- Backfill: the opportunity's primary contact was never written to the
-- ContactsToOpportunities junction, so the detail page showed no contacts.
INSERT INTO "ContactsToOpportunities" ("contact_id", "opportunity_id")
SELECT o."contact", o."id"
FROM "crm_Opportunities" o
JOIN "crm_Contacts" c ON c."id" = o."contact"
WHERE o."contact" IS NOT NULL
ON CONFLICT DO NOTHING;
