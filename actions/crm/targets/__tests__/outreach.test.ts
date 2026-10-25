jest.mock("@/inngest/client", () => ({ inngest: { send: jest.fn() } }));
jest.mock("@/lib/llm/ai-router", () => ({ hasAnyLlmKey: jest.fn() }));
jest.mock("@/lib/authz", () => {
  const actual = jest.requireActual("@/lib/authz/errors");
  return {
    ...actual,
    requireAuthenticated: jest.fn(),
    filterAuthorizedTargetIds: jest.fn(),
    assertCanReadTarget: jest.fn(),
    assertCanWriteTarget: jest.fn(),
    assertCanReadTargetList: jest.fn(),
    targetReadScopeWhere: jest.fn(() => ({ deletedAt: null, created_by: "u1" })),
  };
});
jest.mock("@/lib/prisma", () => ({
  prismadb: {
    crm_Target_Outreach: {
      createManyAndReturn: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    crm_Targets: { findMany: jest.fn() },
    crm_TargetLists: { findUnique: jest.fn() },
  },
}));

import { prismadb } from "@/lib/prisma";
import { inngest } from "@/inngest/client";
import { hasAnyLlmKey } from "@/lib/llm/ai-router";
import { AuthorizationError } from "@/lib/authz/errors";
import {
  requireAuthenticated,
  filterAuthorizedTargetIds,
  assertCanWriteTarget,
} from "@/lib/authz";
import { requestOutreach, markOutreachSent, getOutreachQueuePosition } from "../outreach";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuthenticated as jest.Mock).mockResolvedValue({ id: "u1", role: "user" });
  (hasAnyLlmKey as jest.Mock).mockResolvedValue(true);
});

describe("requestOutreach", () => {
  it("queues one message per authorised target and one Inngest event each", async () => {
    (filterAuthorizedTargetIds as jest.Mock).mockResolvedValue([T1]);
    (prismadb.crm_Target_Outreach.createManyAndReturn as jest.Mock).mockResolvedValue([{ id: "o1" }]);

    const res = await requestOutreach({ targetIds: [T1, T2], channel: "LINKEDIN", language: "fr", instructions: " Be brief " });

    expect(res).toEqual({ queued: 1, skipped: 1 });
    expect((prismadb.crm_Target_Outreach.createManyAndReturn as jest.Mock).mock.calls[0][0].data).toEqual([
      { target_id: T1, channel: "LINKEDIN", language: "fr", instructions: "Be brief", created_by: "u1" },
    ]);
    expect(inngest.send).toHaveBeenCalledWith([
      { name: "crm/target.outreach.requested", data: { outreachId: "o1", refreshProfile: false } },
    ]);
  });

  it("refuses without an LLM key, with an unknown language, or with no authorised target", async () => {
    (hasAnyLlmKey as jest.Mock).mockResolvedValueOnce(false);
    expect(await requestOutreach({ targetIds: [T1], channel: "EMAIL", language: "fr" })).toHaveProperty("error");

    expect(await requestOutreach({ targetIds: [T1], channel: "EMAIL", language: "xx" })).toEqual({
      error: "Unsupported language",
    });

    (filterAuthorizedTargetIds as jest.Mock).mockResolvedValue([]);
    expect(await requestOutreach({ targetIds: [T1], channel: "EMAIL", language: "fr" })).toEqual({ error: "Forbidden" });
    expect(inngest.send).not.toHaveBeenCalled();
  });
});

describe("markOutreachSent", () => {
  it("records the sent date on a ready message the user can write", async () => {
    (prismadb.crm_Target_Outreach.findUnique as jest.Mock).mockResolvedValue({ id: "o1", status: "READY", target_id: T1 });

    expect(await markOutreachSent("o1", true)).toEqual({});
    expect(prismadb.crm_Target_Outreach.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: { status: "SENT", sent_at: expect.any(Date) },
    });
  });

  it("hides messages of targets the user cannot write", async () => {
    (prismadb.crm_Target_Outreach.findUnique as jest.Mock).mockResolvedValue({ id: "o1", status: "READY", target_id: T1 });
    (assertCanWriteTarget as jest.Mock).mockRejectedValueOnce(new AuthorizationError());

    expect(await markOutreachSent("o1", true)).toEqual({ error: "Not found" });
    expect(prismadb.crm_Target_Outreach.update).not.toHaveBeenCalled();
  });

  it("refuses a message still being generated", async () => {
    (prismadb.crm_Target_Outreach.findUnique as jest.Mock).mockResolvedValue({ id: "o1", status: "WRITING", target_id: T1 });
    expect(await markOutreachSent("o1", true)).toEqual({ error: "The message is not ready" });
  });
});

describe("getOutreachQueuePosition", () => {
  it("gives the position, neighbours and the next target not contacted yet", async () => {
    (prismadb.crm_TargetLists.findUnique as jest.Mock).mockResolvedValue({ name: "Apollo — October" });
    (prismadb.crm_Targets.findMany as jest.Mock).mockResolvedValue([
      { id: "a", outreach_messages: [] },
      { id: "b", outreach_messages: [{ id: "m" }] },
      { id: "c", outreach_messages: [{ id: "m" }] },
      { id: "d", outreach_messages: [] },
    ]);

    const res = await getOutreachQueuePosition("b", "list-1");

    expect(res).toEqual({
      listId: "list-1",
      listName: "Apollo — October",
      index: 2,
      total: 4,
      prevId: "a",
      nextId: "c",
      nextUncontactedId: "d",
    });
    expect((prismadb.crm_Targets.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      created_by: "u1",
      target_lists: { some: { target_list_id: "list-1" } },
    });
  });
});
