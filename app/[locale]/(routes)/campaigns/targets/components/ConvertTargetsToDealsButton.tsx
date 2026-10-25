"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Handshake } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { convertTargetsToDeals } from "@/actions/crm/targets/convert-targets-to-deals";

export function ConvertTargetsToDealsButton({ targetIds }: { targetIds: string[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await convertTargetsToDeals(targetIds);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      const parts = [`${result.converted} opportunities created`];
      if (result.existing > 0) parts.push(`${result.existing} already converted`);
      if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
      (result.failed.length > 0 ? toast.warning : toast.success)(parts.join(", "));
      router.refresh();
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={handleClick} disabled={isPending}>
      <Handshake className="h-4 w-4 mr-1" />
      {isPending ? "Converting…" : `Convert ${targetIds.length} to opportunities`}
    </Button>
  );
}
