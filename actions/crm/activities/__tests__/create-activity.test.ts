jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/crm/calendar/outbound-emit", () => ({
  emitCalendarOutbound: jest.fn().mockResolvedValue(undefined),
}));
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
    crm_Activities: { create: jest.fn(), findUnique: jest.fn() },
    crm_ActivityLinks: { createMany: jest.fn() },
    crm_Opportunities: { updateMany: jest.fn() },
    crm_Contacts: { updateMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { prismadb } from "@/lib/prisma";
import {
  requireAuthenticated,
  assertCanReadActivityForEntity,
  AuthorizationError,
} from "@/lib/authz";
import { createActivity } from "../create-activity";

const db = prismadb as any;
const OPP = "11111111-1111-4111-8111-111111111111";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const DATE = new Date("2026-10-20T10:00:00Z");

const base = {
  type: "linkedin" as const,
  title: "Intro message",
  description: "Hi Jane, following up on…",
  date: DATE,
  status: "completed" as const,
  metadata: { direction: "outbound", to: "Jane Doe" },
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
  (assertCanReadActivityForEntity as jest.Mock).mockResolvedValue(undefined);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismadb));
  db.crm_Activities.create.mockResolvedValue({ id: "act-1" });
  db.crm_Activities.findUnique.mockResolvedValue({ id: "act-1", links: [] });
});

it("logs a LinkedIn message and refreshes last_activity on the deal and contact", async () => {
  const res = await createActivity({
    ...base,
    links: [
      { entityType: "opportunity", entityId: OPP },
      { entityType: "contact", entityId: CONTACT },
    ],
  });

  expect(res).toEqual({ data: { id: "act-1", links: [] } });
  expect(db.crm_Activities.create.mock.calls[0][0].data).toMatchObject({
    type: "linkedin",
    createdBy: "u1",
    metadata: { direction: "outbound", to: "Jane Doe" },
  });
  expect(db.crm_Opportunities.updateMany.mock.calls[0][0]).toMatchObject({
    where: { id: { in: [OPP] } },
    data: { last_activity: DATE, last_activity_by: "u1" },
  });
  expect(db.crm_Contacts.updateMany.mock.calls[0][0]).toMatchObject({
    where: { id: { in: [CONTACT] } },
    data: { last_activity: DATE },
  });
});

it("does not touch last_activity for a scheduled activity", async () => {
  await createActivity({
    ...base,
    type: "call",
    status: "scheduled",
    links: [{ entityType: "opportunity", entityId: OPP }],
  });
  expect(db.crm_Opportunities.updateMany).not.toHaveBeenCalled();
});

it("refuses to link an activity to a record the caller cannot read", async () => {
  (assertCanReadActivityForEntity as jest.Mock).mockRejectedValue(new AuthorizationError());
  const res = await createActivity({
    ...base,
    links: [{ entityType: "opportunity", entityId: OPP }],
  });
  expect(res).toEqual({ error: "Forbidden" });
  expect(db.crm_Activities.create).not.toHaveBeenCalled();
});

it("rejects invalid input before touching the database", async () => {
  const res = await createActivity({ ...base, title: "  ", links: [] });
  expect(res).toEqual({ error: "Invalid activity" });
  expect(requireAuthenticated).not.toHaveBeenCalled();
});
