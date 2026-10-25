jest.mock("@/lib/authz", () => {
  const actual = jest.requireActual("@/lib/authz/errors");
  return {
    ...actual,
    requireAuthenticated: jest.fn(),
    assertCanReadActivityForEntity: jest.fn(),
  };
});
jest.mock("@/lib/prisma", () => ({
  prismadb: {
    crm_Opportunities: { findUnique: jest.fn() },
    contactsToOpportunities: { findMany: jest.fn() },
    crm_ActivityLinks: { findMany: jest.fn() },
    crm_Activities: { findMany: jest.fn() },
    email: { findMany: jest.fn() },
  },
}));

import { prismadb } from "@/lib/prisma";
import {
  requireAuthenticated,
  assertCanReadActivityForEntity,
  AuthorizationError,
} from "@/lib/authz";
import { getInteractions } from "../get-interactions";

const db = prismadb as any;
const OPP = "opp-1";

const activityHead = (id: string, type: string, date: string, status = "completed") => ({
  id, type, status, title: `${type} ${id}`, date: new Date(date),
});

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
  (assertCanReadActivityForEntity as jest.Mock).mockResolvedValue(undefined);
  db.crm_Opportunities.findUnique.mockResolvedValue({ contact: "c-primary" });
  db.contactsToOpportunities.findMany.mockResolvedValue([{ contact_id: "c-2" }]);
  db.crm_ActivityLinks.findMany.mockResolvedValue([{ activityId: "a1" }, { activityId: "a2" }, { activityId: "a3" }]);

  const heads = [
    activityHead("a1", "call", "2026-10-01T10:00:00Z"),
    activityHead("a2", "linkedin", "2026-10-05T10:00:00Z"),
    activityHead("a3", "meeting", "2999-01-01T10:00:00Z", "scheduled"),
  ];
  db.crm_Activities.findMany.mockImplementation(async (args: any) =>
    args.select ? heads : heads
      .filter((h) => args.where.id.in.includes(h.id))
      .map((h) => ({ ...h, links: [], created_by_user: null }))
  );
  db.email.findMany.mockImplementation(async (args: any) =>
    args.where.id
      ? [{ id: "e1", folder: "SENT", subject: "Proposal", fromName: null, fromEmail: "me@x.io", toRecipients: [{ email: "jane@acme.com" }], bodyText: "Hello" }]
      : [{ id: "e1", sentAt: new Date("2026-10-03T10:00:00Z"), createdAt: new Date("2026-10-03T10:00:00Z") }]
  );
});

it("merges activities and emails of the deal's contacts in reverse chronological order", async () => {
  const page = await getInteractions("opportunity", OPP);

  expect(page.data.map((i) => i.id)).toEqual(["a3", "a2", "e1", "a1"]);
  const email = page.data.find((i) => i.kind === "email");
  expect(email).toMatchObject({ email: { subject: "Proposal", to: ["jane@acme.com"], folder: "SENT" } });

  // Activities on the deal or on any of its contacts (junction + primary contact).
  const linkWhere = db.crm_ActivityLinks.findMany.mock.calls[0][0].where;
  expect(linkWhere.OR).toEqual([
    { entityType: "opportunity", entityId: OPP },
    { entityType: "contact", entityId: { in: ["c-2", "c-primary"] } },
  ]);
});

it("summarises touchpoints and the next scheduled action", async () => {
  const { summary } = await getInteractions("opportunity", OPP);
  expect(summary).toMatchObject({ emails: 1, linkedin: 1, calls: 1, meetings: 0 });
  expect(summary.lastContactAt).toEqual(new Date("2026-10-05T10:00:00Z"));
  expect(summary.nextScheduled?.title).toBe("meeting a3");
});

it("filters by type", async () => {
  const page = await getInteractions("opportunity", OPP, { types: ["email"] });
  expect(page.data.map((i) => i.id)).toEqual(["e1"]);
});

it("only shows a plain user their own mailbox", async () => {
  await getInteractions("opportunity", OPP);
  expect(db.email.findMany.mock.calls[0][0].where.userId).toBe("u1");

  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "m1", role: "manager" });
  db.email.findMany.mockClear();
  await getInteractions("opportunity", OPP);
  expect(db.email.findMany.mock.calls[0][0].where.userId).toBeUndefined();
});

it("returns an empty page when the caller cannot read the record", async () => {
  (assertCanReadActivityForEntity as jest.Mock).mockRejectedValue(new AuthorizationError());
  const page = await getInteractions("opportunity", OPP);
  expect(page.data).toEqual([]);
  expect(db.crm_ActivityLinks.findMany).not.toHaveBeenCalled();
});
