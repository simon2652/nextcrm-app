"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { requestOutreach } from "@/actions/crm/targets/outreach";
import { OUTREACH_BULK_MAX } from "@/lib/outreach/constants";
import { OutreachComposer, type OutreachRequest } from "./OutreachComposer";

/** Queue one personalised message per selected target; each is reviewed on the target page. */
export function BulkOutreachDialog({ targetIds }: { targetIds: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const tooMany = targetIds.length > OUTREACH_BULK_MAX;

  async function submit(request: OutreachRequest) {
    setBusy(true);
    try {
      const result = await requestOutreach({ targetIds, ...request, refreshProfile: false });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${result.queued} messages queued${result.skipped ? `, ${result.skipped} skipped` : ""}. Open each target to review and send.`
      );
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={targetIds.length === 0}>
          <Sparkles className="h-4 w-4 mr-1 text-violet-500" />
          Generate {targetIds.length} messages
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate personalised messages</DialogTitle>
          <DialogDescription>
            For each of the {targetIds.length} targets, the AI researches the professional profile, analyses the job
            title and writes a message from your product knowledge. Drafts appear on each target page, ready to review.
          </DialogDescription>
        </DialogHeader>
        {tooMany ? (
          <p className="text-sm text-destructive">Select at most {OUTREACH_BULK_MAX} targets per batch.</p>
        ) : (
          <OutreachComposer onSubmit={submit} submitLabel={`Generate ${targetIds.length} messages`} busy={busy} />
        )}
      </DialogContent>
    </Dialog>
  );
}
