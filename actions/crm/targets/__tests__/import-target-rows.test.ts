jest.mock("@/lib/authz", () => ({
  requireAuthenticated: jest.fn(),
  assertCanWriteTargetList: jest.fn(),
  targetReadScopeWhere: jest.fn(() => ({ deletedAt: null, created_by: "u1" })),
}));
jest.mock("@/lib/prisma", () => ({
  prismadb: {
    crm_Targets: { findMany: jest.fn(), createMany: jest.fn(), createManyAndReturn: jest.fn() },
    targetsToTargetLists: { createMany: jest.fn() },
  },
}));

import { prismadb } from "@/lib/prisma";
import { requireAuthenticated, assertCanWriteTargetList } from "@/lib/authz";
import { importTargetRows } from "../import-targets";

const LIST = "33333333-3333-4333-8333-333333333333";
const findMany = prismadb.crm_Targets.findMany as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
});

it("imports mapped rows into a list, skipping emails already in the CRM but still listing them", async () => {
  findMany
    .mockResolvedValueOnce([{ id: "existing-1", email: "known@acme.com" }]) // dedupe lookup
    .mockResolvedValueOnce([]); // suppression lookup
  (prismadb.crm_Targets.createManyAndReturn as jest.Mock).mockResolvedValue([{ id: "new-1" }]);

  const res = await importTargetRows({
    rows: [
      { last_name: "Known", email: "KNOWN@acme.com" },
      { last_name: "Fresh", email: "fresh@acme.com", position: " Head of Bids ", unknown_column: "dropped" },
      { last_name: "Fresh twin", email: "fresh@acme.com" },
      { first_name: "No last name" },
    ],
    listId: LIST,
    dedupe: true,
    firstRowNumber: 502,
  });

  expect(assertCanWriteTargetList).toHaveBeenCalledWith({ id: "u1", role: "user" }, LIST);
  expect(res).toEqual({ imported: 1, skipped: 1, duplicates: 2, errors: ["Row 505: missing last_name or company"] });

  const created = (prismadb.crm_Targets.createManyAndReturn as jest.Mock).mock.calls[0][0].data;
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ last_name: "Fresh", position: "Head of Bids", created_by: "u1" });
  expect(created[0]).not.toHaveProperty("unknown_column");

  expect(prismadb.targetsToTargetLists.createMany).toHaveBeenCalledWith({
    data: [
      { target_id: "new-1", target_list_id: LIST },
      { target_id: "existing-1", target_list_id: LIST },
    ],
    skipDuplicates: true,
  });
});

it("rejects batches above the size limit", async () => {
  await expect(importTargetRows({ rows: Array.from({ length: 501 }, () => ({ last_name: "x" })) })).rejects.toThrow();
});
