"use server";
import { z } from "zod";
import { prismadb } from "@/lib/prisma";
import { parseSpreadsheetFile } from "@/lib/spreadsheet/parse";
import { TARGET_FIELDS } from "@/lib/spreadsheet/target-fields";
import {
  requireAuthenticated,
  assertCanWriteTargetList,
  targetReadScopeWhere,
  type AuthzUser,
} from "@/lib/authz";

type ImportResult = { imported: number; skipped: number; errors: string[]; duplicates: number };

interface InsertOptions {
  /** Add the imported (and duplicate) targets to this list. */
  listId?: string | null;
  /** Do not create a target whose email already exists in the CRM (it is still added to the list). */
  dedupe?: boolean;
  /** Spreadsheet row number of rows[0], for error messages. */
  firstRowNumber?: number;
}

async function insertTargets(
  user: AuthzUser,
  rows: Record<string, string>[],
  { listId, dedupe = false, firstRowNumber = 2 }: InsertOptions
): Promise<ImportResult> {
  if (listId) await assertCanWriteTargetList(user, listId);

  const valid: any[] = [];
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const last_name = row.last_name;
    const email = row.email;
    const mobile_phone = row.mobile_phone;
    const company = row.company;

    if (!last_name && !company) {
      errors.push(`Row ${index + firstRowNumber}: missing last_name or company`);
      return;
    }

    valid.push({
      last_name: last_name ?? "",
      first_name: row.first_name || null,
      email: email || null,
      mobile_phone: mobile_phone || null,
      office_phone: row.office_phone || null,
      company: row.company || null,
      position: row.position || null,
      company_website: row.company_website || null,
      personal_website: row.personal_website || null,
      social_linkedin: row.social_linkedin || null,
      social_x: row.social_x || null,
      social_instagram: row.social_instagram || null,
      social_facebook: row.social_facebook || null,
      personal_email: row.personal_email || null,
      company_email: row.company_email || null,
      company_phone: row.company_phone || null,
      city: row.city || null,
      country: row.country || null,
      industry: row.industry || null,
      employees: row.employees || null,
      description: row.description || null,
      created_by: user.id,
    });
  });

  let toCreate = valid;
  const existingIds: string[] = [];
  if (dedupe && valid.length > 0) {
    const emails = valid.map((v) => v.email).filter(Boolean) as string[];
    const existing = emails.length
      ? await prismadb.crm_Targets.findMany({
          where: { ...targetReadScopeWhere(user), email: { in: emails, mode: "insensitive" } },
          select: { id: true, email: true },
        })
      : [];
    const byEmail = new Map(existing.map((e) => [(e.email ?? "").toLowerCase(), e.id]));
    const seen = new Set<string>();
    toCreate = valid.filter((v) => {
      const key = v.email?.toLowerCase();
      if (!key) return true;
      const existingId = byEmail.get(key);
      if (existingId) {
        existingIds.push(existingId);
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const duplicates = valid.length - toCreate.length;

  let createdIds: string[] = [];
  if (toCreate.length > 0) {
    // Inherit global suppression: a re-imported address that previously
    // unsubscribed must never become emailable again via import.
    const emails = toCreate.map((v) => v.email).filter(Boolean) as string[];
    if (emails.length > 0) {
      const suppressed = await prismadb.crm_Targets.findMany({
        where: {
          do_not_email: true,
          email: { in: emails, mode: "insensitive" },
        },
        select: { email: true },
      });
      const suppressedEmails = new Set(
        suppressed.map((s) => (s.email ?? "").toLowerCase())
      );
      for (const row of toCreate) {
        if (row.email && suppressedEmails.has(row.email.toLowerCase())) {
          row.do_not_email = true;
          row.do_not_email_at = new Date();
        }
      }
    }
    if (listId) {
      const created = await prismadb.crm_Targets.createManyAndReturn({ data: toCreate, select: { id: true } });
      createdIds = created.map((c) => c.id);
    } else {
      await prismadb.crm_Targets.createMany({ data: toCreate, skipDuplicates: true });
    }
  }

  if (listId) {
    const ids = Array.from(new Set([...createdIds, ...existingIds]));
    if (ids.length > 0) {
      await prismadb.targetsToTargetLists.createMany({
        data: ids.map((target_id) => ({ target_id, target_list_id: listId })),
        skipDuplicates: true,
      });
    }
  }

  return { imported: toCreate.length, skipped: errors.length, errors, duplicates };
}

export async function importTargets(
  formData: FormData
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  // Plain bulk create; rows are owned by the importer. requireAuthenticated
  // throws on no session, matching this function's throw-based contract.
  const user = await requireAuthenticated();

  const file = formData.get("file") as File | null;
  if (!file) throw new Error("No file provided");

  const mappingRaw = formData.get("mapping") as string | null;
  const mapping: Record<string, string> = mappingRaw ? JSON.parse(mappingRaw) : {};
  const listId = (formData.get("listId") as string | null) || null;

  const data = await parseSpreadsheetFile(file);
  const rows = data.map((rawRow) => {
    const row: Record<string, string> = {};
    if (Object.keys(mapping).length > 0) {
      Object.entries(mapping).forEach(([csvCol, targetField]) => {
        if (targetField && rawRow[csvCol] !== undefined) {
          row[targetField] = rawRow[csvCol];
        }
      });
    } else {
      Object.assign(row, rawRow);
    }
    return row;
  });

  return insertTargets(user, rows, { listId });
}

const FIELD_KEYS = new Set(TARGET_FIELDS.map((f) => f.key));
const IMPORT_BATCH_ROWS = 500;

const batchSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.string().max(5000)))
    .max(IMPORT_BATCH_ROWS),
  listId: z.string().uuid().nullish(),
  dedupe: z.boolean().optional(),
  firstRowNumber: z.number().int().min(1).optional(),
});

/**
 * Import already-mapped rows (keys = target fields). The import modal sends
 * large files (Apollo exports, lead tools…) in batches through this action,
 * which keeps every request well under the server action body limit.
 */
export async function importTargetRows(input: z.input<typeof batchSchema>): Promise<ImportResult> {
  const user = await requireAuthenticated();
  const { rows, listId, dedupe, firstRowNumber } = batchSchema.parse(input);
  const clean = rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => FIELD_KEYS.has(key)).map(([k, v]) => [k, v.trim()]))
  );
  return insertTargets(user, clean, { listId, dedupe, firstRowNumber });
}
