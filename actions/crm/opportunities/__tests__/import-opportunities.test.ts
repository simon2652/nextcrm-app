jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/inngest/client", () => ({ inngest: { send: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("@/lib/audit-log", () => ({ writeAuditLog: jest.fn() }));
jest.mock("@/lib/currency", () => ({
  getDefaultCurrency: jest.fn().mockResolvedValue("EUR"),
  getSnapshotRate: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/crm/stage-transition", () => ({ handleStageTransition: jest.fn() }));
jest.mock("@/lib/spreadsheet/parse", () => ({ parseSpreadsheetFile: jest.fn() }));
jest.mock("@/lib/authz", () => {
  const actual = jest.requireActual("@/lib/authz/errors");
  return {
    ...actual,
    requireAuthenticated: jest.fn(),
    accountReadScopeWhere: jest.fn(() => ({ deletedAt: null })),
    contactReadScopeWhere: jest.fn(() => ({ deletedAt: null })),
  };
});
jest.mock("@/lib/prisma", () => ({
  prismadb: {
    crm_Opportunities_Sales_Stages: { findMany: jest.fn() },
    currency: { findMany: jest.fn() },
    crm_Accounts: { findFirst: jest.fn(), create: jest.fn() },
    crm_Contacts: { findFirst: jest.fn(), create: jest.fn() },
    crm_Opportunities: { create: jest.fn() },
  },
}));

import { prismadb } from "@/lib/prisma";
import { requireAuthenticated } from "@/lib/authz";
import { parseSpreadsheetFile } from "@/lib/spreadsheet/parse";
import { inngest } from "@/inngest/client";
import { importOpportunities } from "../import-opportunities";

const db = prismadb as any;

function formData(mapping?: Record<string, string>) {
  const fd = new FormData();
  fd.append("file", new File(["x"], "deals.csv"));
  if (mapping) fd.append("mapping", JSON.stringify(mapping));
  return fd;
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
  db.crm_Opportunities_Sales_Stages.findMany.mockResolvedValue([
    { id: "stage-entry", name: "Prospecting", order: 0 },
    { id: "stage-qual", name: "Qualified", order: 1 },
  ]);
  db.currency.findMany.mockResolvedValue([{ code: "EUR" }, { code: "USD" }]);
  db.crm_Accounts.findFirst.mockResolvedValue(null);
  db.crm_Accounts.create.mockResolvedValue({ id: "acc-new" });
  db.crm_Contacts.findFirst.mockResolvedValue(null);
  db.crm_Contacts.create.mockResolvedValue({ id: "contact-new" });
  let n = 0;
  db.crm_Opportunities.create.mockImplementation(async (args: any) => ({
    id: `opp-${++n}`,
    sales_stage: args.data.sales_stage,
  }));
});

it("maps columns, creates account + contact once and links the contact to each deal", async () => {
  (parseSpreadsheetFile as jest.Mock).mockResolvedValue([
    { Deal: "Acme renewal", Amount: "12 500,50", Company: "Acme", Email: "jane@acme.com", Stage: "qualified", Close: "31/12/2026" },
    { Deal: "Acme upsell", Amount: "3000", Company: "ACME", Email: "JANE@acme.com", Stage: "", Close: "" },
  ]);

  const res = await importOpportunities(
    formData({ Deal: "name", Amount: "budget", Company: "account_name", Email: "contact_email", Stage: "sales_stage", Close: "close_date" })
  );

  expect(res).toEqual({ imported: 2, skipped: 0, errors: [] });
  expect(db.crm_Accounts.create).toHaveBeenCalledTimes(1);
  expect(db.crm_Contacts.create).toHaveBeenCalledTimes(1);

  const first = db.crm_Opportunities.create.mock.calls[0][0].data;
  expect(first).toMatchObject({
    name: "Acme renewal",
    budget: 12500.5,
    account: "acc-new",
    contact: "contact-new",
    contacts: { create: [{ contact_id: "contact-new" }] },
    sales_stage: "stage-qual",
    currency: "EUR",
    close_date: new Date(Date.UTC(2026, 11, 31)),
  });
  // No stage given → entry stage.
  expect(db.crm_Opportunities.create.mock.calls[1][0].data.sales_stage).toBe("stage-entry");

  const events = (inngest.send as jest.Mock).mock.calls[0][0].map((e: any) => e.name);
  expect(events).toEqual(
    expect.arrayContaining(["crm/opportunity.saved", "crm/account.saved", "crm/contact.saved"])
  );
});

it("reuses an existing account and contact the user can see", async () => {
  db.crm_Accounts.findFirst.mockResolvedValue({ id: "acc-existing" });
  db.crm_Contacts.findFirst.mockResolvedValue({ id: "contact-existing" });
  (parseSpreadsheetFile as jest.Mock).mockResolvedValue([
    { name: "Deal", account_name: "Acme", contact_email: "jane@acme.com" },
  ]);

  await importOpportunities(formData());

  expect(db.crm_Accounts.create).not.toHaveBeenCalled();
  expect(db.crm_Contacts.create).not.toHaveBeenCalled();
  expect(db.crm_Opportunities.create.mock.calls[0][0].data).toMatchObject({
    account: "acc-existing",
    contact: "contact-existing",
  });
});

it("reports invalid rows and imports the rest", async () => {
  (parseSpreadsheetFile as jest.Mock).mockResolvedValue([
    { name: "", budget: "10" },
    { name: "Bad amount", budget: "abc" },
    { name: "Bad stage", sales_stage: "Nope" },
    { name: "Bad currency", currency: "XYZ" },
    { name: "Good" },
  ]);

  const res = await importOpportunities(formData());

  expect(res.imported).toBe(1);
  expect(res.skipped).toBe(4);
  expect(res.errors[0]).toMatch(/^Row 2: missing name/);
  expect(res.errors[1]).toMatch(/^Row 3: invalid amount/);
  expect(res.errors[2]).toMatch(/^Row 4: unknown sales stage/);
  expect(res.errors[3]).toMatch(/^Row 5: unknown currency/);
});

it("rejects files over the row limit", async () => {
  (parseSpreadsheetFile as jest.Mock).mockResolvedValue(
    Array.from({ length: 501 }, (_, i) => ({ name: `Deal ${i}` }))
  );
  await expect(importOpportunities(formData())).rejects.toThrow("limited to 500 rows");
  expect(db.crm_Opportunities.create).not.toHaveBeenCalled();
});
