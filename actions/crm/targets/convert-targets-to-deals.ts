"use server";
import { revalidatePath } from "next/cache";
import {
  requireAuthenticated,
  filterAuthorizedTargetIds,
  AuthenticationError,
} from "@/lib/authz";
import { prismadb } from "@/lib/prisma";
import { convertTargetToDeal } from "./convert-target-to-deal";

const MAX_TARGETS = 200;

/**
 * Bulk "Convert to opportunity". Each target goes through convertTargetToDeal
 * (account + contact + deal), which is idempotent: a target that already has a
 * deal returns it and is counted as `existing`.
 */
export async function convertTargetsToDeals(
  targetIds: string[]
): Promise<{ converted: number; existing: number; failed: string[] } | { error: string }> {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    throw e;
  }
  if (!Array.isArray(targetIds) || targetIds.length === 0) return { error: "No targets selected" };
  if (targetIds.length > MAX_TARGETS) {
    return { error: `Convert at most ${MAX_TARGETS} targets at a time` };
  }

  const authorized = await filterAuthorizedTargetIds(user, targetIds);
  const failed = targetIds.filter((id) => !authorized.includes(id));
  const opportunityIds: string[] = [];
  const startedAt = new Date();

  // Sequential: each conversion runs its own transaction and stage hooks.
  for (const id of authorized) {
    const result = await convertTargetToDeal(id);
    if ("error" in result) failed.push(id);
    else opportunityIds.push(result.opportunityId);
  }

  const converted = await prismadb.crm_Opportunities.count({
    where: { id: { in: opportunityIds }, createdAt: { gte: startedAt } },
  });

  revalidatePath("/[locale]/(routes)/campaigns/targets", "page");
  revalidatePath("/[locale]/(routes)/crm/opportunities", "page");
  return { converted, existing: opportunityIds.length - converted, failed };
}
