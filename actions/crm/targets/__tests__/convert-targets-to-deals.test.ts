jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("../convert-target-to-deal", () => ({ convertTargetToDeal: jest.fn() }));
jest.mock("@/lib/authz", () => {
  const actual = jest.requireActual("@/lib/authz/errors");
  return {
    ...actual,
    requireAuthenticated: jest.fn(),
    filterAuthorizedTargetIds: jest.fn(),
  };
});
jest.mock("@/lib/prisma", () => ({
  prismadb: { crm_Opportunities: { count: jest.fn() } },
}));

import { prismadb } from "@/lib/prisma";
import { requireAuthenticated, filterAuthorizedTargetIds } from "@/lib/authz";
import { convertTargetToDeal } from "../convert-target-to-deal";
import { convertTargetsToDeals } from "../convert-targets-to-deals";

const convert = convertTargetToDeal as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
});

it("converts authorized targets, counts existing deals and reports failures", async () => {
  (filterAuthorizedTargetIds as jest.Mock).mockResolvedValue(["t1", "t2", "t3"]);
  convert
    .mockResolvedValueOnce({ accountId: "a1", contactId: "c1", opportunityId: "o1" })
    .mockResolvedValueOnce({ accountId: "a2", contactId: "c2", opportunityId: "o2" })
    .mockResolvedValueOnce({ error: "Target not found" });
  (prismadb.crm_Opportunities.count as jest.Mock).mockResolvedValue(1);

  const res = await convertTargetsToDeals(["t1", "t2", "t3", "t-forbidden"]);

  expect(convert).toHaveBeenCalledTimes(3);
  expect(res).toEqual({ converted: 1, existing: 1, failed: ["t-forbidden", "t3"] });
});

it("caps the batch size", async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
  expect(await convertTargetsToDeals(ids)).toEqual({ error: "Convert at most 200 targets at a time" });
  expect(convert).not.toHaveBeenCalled();
});
