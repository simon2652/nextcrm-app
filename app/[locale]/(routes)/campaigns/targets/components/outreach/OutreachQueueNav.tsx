import Link from "next/link";
import { ChevronLeft, ChevronRight, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getOutreachQueuePosition } from "@/actions/crm/targets/outreach";

/** "Lead 3 / 120" navigation for processing an imported list one target at a time. */
export async function OutreachQueueNav({ targetId, listId }: { targetId: string; listId?: string | null }) {
  const position = await getOutreachQueuePosition(targetId, listId);
  if ("error" in position) return null;

  const href = (id: string) => `/campaigns/targets/${id}${position.listId ? `?list=${position.listId}` : ""}`;
  const nav = (id: string | null, label: string, icon: React.ReactNode, iconAfter = false) =>
    id ? (
      <Button asChild size="sm" variant="outline">
        <Link href={href(id)}>
          {!iconAfter && icon}
          {label}
          {iconAfter && icon}
        </Link>
      </Button>
    ) : (
      <Button size="sm" variant="outline" disabled>
        {!iconAfter && icon}
        {label}
        {iconAfter && icon}
      </Button>
    );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <span className="text-sm">
        Lead <span className="font-medium">{position.index}</span> / {position.total}
        {position.listName ? (
          <>
            {" "}in{" "}
            <Link href={`/campaigns/target-lists/${position.listId}`} className="font-medium hover:underline">
              {position.listName}
            </Link>
          </>
        ) : (
          " (all targets)"
        )}
      </span>
      <div className="ml-auto flex flex-wrap gap-2">
        {nav(position.prevId, "Previous", <ChevronLeft className="h-4 w-4 mr-1" />)}
        {nav(position.nextId, "Next", <ChevronRight className="h-4 w-4 ml-1" />, true)}
        {nav(position.nextUncontactedId, "Next not contacted", <SkipForward className="h-4 w-4 ml-1" />, true)}
      </div>
    </div>
  );
}
