"use server";
import { z } from "zod";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { inngest } from "@/inngest/client";
import { writeAuditLog } from "@/lib/audit-log";
import { junctionTableHelpers } from "@/lib/junction-helpers";
import { parseSpreadsheetFile } from "@/lib/spreadsheet/parse";
import { OPPORTUNITY_IMPORT_MAX_ROWS } from "@/lib/spreadsheet/opportunity-fields";
import { getSnapshotRate, getDefaultCurrency } from "@/lib/currency";
import { handleStageTransition } from "@/lib/crm/stage-transition";
import {
  requireAuthenticated,
  accountReadScopeWhere,
  contactReadScopeWhere,
  AuthenticationError,
} from "@/lib/authz";

const optional = z
  .string()
  .trim()
  .transform((s) => s || undefined)
  .optional();

// "12 500,50" / "12500.50" / "€ 12,500" → number
const amount = optional.transform((s, ctx) => {
  if (s === undefined) return undefined;
  let cleaned = s.replace(/[^0-9.,-]/g, "");
  if (cleaned.includes(",") && cleaned.includes(".")) cleaned = cleaned.replace(/,/g, "");
  else cleaned = cleaned.replace(",", ".");
  const n = Number(cleaned);
  if (!/\d/.test(cleaned) || !Number.isFinite(n) || n < 0) {
    ctx.addIssue({ code: "custom", message: `invalid amount "${s}"` });
    return z.NEVER;
  }
  return n;
});

// ISO dates, or DD/MM/YYYY as exported by European spreadsheets.
const date = optional.transform((s, ctx) => {
  if (s === undefined) return undefined;
  const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  const d = dmy ? new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])) : new Date(s);
  if (isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: `invalid date "${s}"` });
    return z.NEVER;
  }
  return d;
});

const rowSchema = z.object({
  name: z.string({ error: "missing name" }).trim().min(1, "missing name"),
  budget: amount,
  expected_revenue: amount,
  currency: optional.transform((s) => s?.toUpperCase()),
  close_date: date,
  sales_stage: optional,
  description: optional,
  next_step: optional,
  account_name: optional,
  contact_first_name: optional,
  contact_last_name: optional,
  contact_email: optional.pipe(z.string().email("invalid contact email").optional()),
});

export async function importOpportunities(
  formData: FormData
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) throw new Error("Unauthorized");
    throw e;
  }

  const file = formData.get("file") as File | null;
  if (!file) throw new Error("No file provided");

  const mappingRaw = formData.get("mapping") as string | null;
  const mapping: Record<string, string> = mappingRaw ? JSON.parse(mappingRaw) : {};

  const data = await parseSpreadsheetFile(file);
  if (data.length > OPPORTUNITY_IMPORT_MAX_ROWS) {
    throw new Error(
      `Import limited to ${OPPORTUNITY_IMPORT_MAX_ROWS} rows. File contains ${data.length} rows.`
    );
  }

  const [stages, currencies, defaultCurrency] = await Promise.all([
    prismadb.crm_Opportunities_Sales_Stages.findMany({
      select: { id: true, name: true, order: true },
      orderBy: { order: "asc" },
    }),
    prismadb.currency.findMany({ where: { isEnabled: true }, select: { code: true } }),
    getDefaultCurrency(),
  ]);
  const stageByName = new Map(stages.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const entryStageId = stages[0]?.id;
  const currencyCodes = new Set(currencies.map((c) => c.code));

  // Rows of the same file often share an account / contact.
  const accountCache = new Map<string, string>();
  const contactCache = new Map<string, string>();
  const created = { accounts: [] as string[], contacts: [] as string[], opportunities: [] as string[] };
  const errors: string[] = [];

  for (let index = 0; index < data.length; index++) {
    const rawRow = data[index];
    const rowNum = index + 2;
    const mapped: Record<string, string> = {};
    if (Object.keys(mapping).length > 0) {
      for (const [csvCol, field] of Object.entries(mapping)) {
        if (field && rawRow[csvCol] !== undefined) mapped[field] = rawRow[csvCol];
      }
    } else {
      Object.assign(mapped, rawRow);
    }

    const parsed = rowSchema.safeParse(mapped);
    if (!parsed.success) {
      errors.push(`Row ${rowNum}: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
      continue;
    }
    const row = parsed.data;

    if (row.currency && !currencyCodes.has(row.currency)) {
      errors.push(`Row ${rowNum}: unknown currency "${row.currency}"`);
      continue;
    }
    let salesStage: string | undefined = entryStageId;
    if (row.sales_stage) {
      salesStage = stageByName.get(row.sales_stage.toLowerCase());
      if (!salesStage) {
        errors.push(`Row ${rowNum}: unknown sales stage "${row.sales_stage}"`);
        continue;
      }
    }

    try {
      let accountId: string | undefined;
      if (row.account_name) {
        const key = row.account_name.toLowerCase();
        accountId = accountCache.get(key);
        if (!accountId) {
          const existing = await prismadb.crm_Accounts.findFirst({
            where: {
              ...accountReadScopeWhere(user),
              name: { equals: row.account_name, mode: "insensitive" },
            },
            select: { id: true },
          });
          accountId =
            existing?.id ??
            (
              await prismadb.crm_Accounts.create({
                data: {
                  v: 0,
                  name: row.account_name,
                  status: "Active",
                  assigned_to: user.id,
                  createdBy: user.id,
                },
                select: { id: true },
              })
            ).id;
          if (!existing) created.accounts.push(accountId);
          accountCache.set(key, accountId);
        }
      }

      let contactId: string | undefined;
      const hasContact = row.contact_email || row.contact_last_name || row.contact_first_name;
      if (hasContact) {
        const key = (row.contact_email ?? `${row.contact_first_name} ${row.contact_last_name}`).toLowerCase();
        contactId = contactCache.get(key);
        if (!contactId) {
          const existing = row.contact_email
            ? await prismadb.crm_Contacts.findFirst({
                where: {
                  ...contactReadScopeWhere(user),
                  email: { equals: row.contact_email, mode: "insensitive" },
                },
                select: { id: true },
              })
            : null;
          contactId =
            existing?.id ??
            (
              await prismadb.crm_Contacts.create({
                data: {
                  v: 0,
                  first_name: row.contact_first_name,
                  last_name: row.contact_last_name ?? row.contact_email ?? "Unknown",
                  email: row.contact_email,
                  accountsIDs: accountId,
                  assigned_to: user.id,
                  createdBy: user.id,
                },
                select: { id: true },
              })
            ).id;
          if (!existing) created.contacts.push(contactId);
          contactCache.set(key, contactId);
        }
      }

      const currency = row.currency ?? defaultCurrency;
      const snapshotRate = currency ? await getSnapshotRate(currency, defaultCurrency) : null;

      const opportunity = await prismadb.crm_Opportunities.create({
        data: {
          name: row.name,
          account: accountId,
          contact: contactId,
          contacts: junctionTableHelpers.connectContactsToOpportunity(contactId ? [contactId] : []),
          budget: row.budget,
          expected_revenue: row.expected_revenue,
          currency,
          snapshot_rate: snapshotRate ? parseFloat(snapshotRate.toString()) : undefined,
          close_date: row.close_date,
          description: row.description,
          next_step: row.next_step,
          sales_stage: salesStage,
          stage_entered_at: new Date(),
          status: "ACTIVE",
          assigned_to: user.id,
          createdBy: user.id,
          updatedBy: user.id,
          last_activity_by: user.id,
        },
        select: { id: true, sales_stage: true },
      });

      await handleStageTransition({
        opportunityId: opportunity.id,
        fromStage: null,
        toStage: opportunity.sales_stage ?? null,
      });
      created.opportunities.push(opportunity.id);
    } catch (error) {
      console.error(`[IMPORT_OPPORTUNITIES] row ${rowNum}`, error);
      errors.push(`Row ${rowNum}: could not be imported`);
    }
  }

  if (created.opportunities.length > 0) {
    await writeAuditLog({
      entityType: "opportunity",
      entityId: "bulk_import",
      action: "imported",
      changes: [
        { field: "opportunities", old: null, new: created.opportunities.length },
        { field: "accounts", old: null, new: created.accounts.length },
        { field: "contacts", old: null, new: created.contacts.length },
      ],
      userId: user.id,
    });

    // Embeddings are generated per record from these events.
    const events = [
      ...created.opportunities.map((id) => ({ name: "crm/opportunity.saved" as const, data: { record_id: id } })),
      ...created.accounts.map((id) => ({ name: "crm/account.saved" as const, data: { record_id: id } })),
      ...created.contacts.map((id) => ({ name: "crm/contact.saved" as const, data: { record_id: id } })),
    ];
    for (let i = 0; i < events.length; i += 512) {
      void inngest.send(events.slice(i, i + 512));
    }
  }

  revalidatePath("/[locale]/(routes)/crm/opportunities", "page");
  return { imported: created.opportunities.length, skipped: errors.length, errors };
}
