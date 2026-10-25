import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { buildOutreachProfile, type OutreachProfile } from "@/lib/outreach/profile";
import { knowledgeQuery, writeOutreachMessage, type OutreachChannel } from "@/lib/outreach/write";
import { retrieveKnowledge } from "@/lib/knowledge/retrieve";

const OUTREACH_PER_MINUTE = Math.max(1, Number(process.env.OUTREACH_PER_MINUTE) || 5);

const TARGET_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  company: true,
  company_website: true,
  position: true,
  social_linkedin: true,
  city: true,
  country: true,
  industry: true,
  employees: true,
  description: true,
  outreach_profile: true,
} as const;

/**
 * One personalised outreach message: research the prospect's professional
 * profile (reused across messages unless a refresh is asked), retrieve the
 * product knowledge matching their persona, then write for the channel.
 * Every LLM call goes through the AI router.
 */
export const generateOutreach = inngest.createFunction(
  {
    id: "outreach-generate",
    name: "Generate Outreach Message",
    triggers: [{ event: "crm/target.outreach.requested" }],
    retries: 2,
    // Bulk generation: each message makes ~3 LLM calls; stay within provider
    // quotas (Gemini free tier included). Raise OUTREACH_PER_MINUTE on paid plans.
    concurrency: { limit: 3 },
    throttle: { limit: OUTREACH_PER_MINUTE, period: "1m" },
    onFailure: async ({ event, error }) => {
      const { outreachId } = event.data.event.data as { outreachId: string };
      await prismadb.crm_Target_Outreach.updateMany({
        where: { id: outreachId },
        data: { status: "FAILED", error: error.message.slice(0, 1000) },
      });
    },
  },
  async ({ event, step }) => {
    const { outreachId, refreshProfile } = event.data as { outreachId: string; refreshProfile?: boolean };

    const job = await step.run("load", async () => {
      const outreach = await prismadb.crm_Target_Outreach.findUnique({
        where: { id: outreachId },
        select: {
          id: true,
          channel: true,
          language: true,
          instructions: true,
          created_by: true,
          target: { select: TARGET_SELECT },
        },
      });
      if (!outreach) return null;
      const sender = outreach.created_by
        ? await prismadb.users.findUnique({ where: { id: outreach.created_by }, select: { name: true } })
        : null;
      await prismadb.crm_Target_Outreach.update({ where: { id: outreachId }, data: { status: "RESEARCHING", error: null } });
      return { ...outreach, senderName: sender?.name ?? null };
    });
    if (!job) return { skipped: "outreach not found" };

    const context = { userId: job.created_by ?? undefined, procedure: "outreach", correlationId: outreachId };
    const { outreach_profile, ...target } = job.target;

    const profile = await step.run("research-profile", async () => {
      if (outreach_profile && !refreshProfile) return outreach_profile as unknown as OutreachProfile;
      const built = await buildOutreachProfile(target, context);
      await prismadb.crm_Targets.update({
        where: { id: target.id },
        data: {
          outreach_profile: built as object,
          outreach_profile_at: new Date(),
          // Fill gaps in the imported data, never overwrite it.
          ...(!target.position && built.professional.currentTitle && { position: built.professional.currentTitle }),
          ...(!target.social_linkedin && built.professional.linkedinUrl && { social_linkedin: built.professional.linkedinUrl }),
        },
      });
      return built;
    });

    const knowledge = await step.run("retrieve-knowledge", async () => {
      await prismadb.crm_Target_Outreach.update({ where: { id: outreachId }, data: { status: "WRITING" } });
      return retrieveKnowledge(knowledgeQuery(target, profile, job.instructions));
    });

    return step.run("write-message", async () => {
      const draft = await writeOutreachMessage({
        target,
        profile,
        channel: job.channel as OutreachChannel,
        language: job.language,
        instructions: job.instructions,
        sender: { name: job.senderName },
        knowledge,
        context,
      });
      await prismadb.crm_Target_Outreach.update({
        where: { id: outreachId },
        data: {
          status: "READY",
          subject: draft.subject,
          body: draft.body,
          warnings: draft.warnings,
          model_used: draft.modelUsed,
          knowledge_sources: knowledge.excerpts.map((e) => ({ document: e.document, heading: e.heading })),
        },
      });
      return { outreachId, warnings: draft.warnings.length };
    });
  }
);
