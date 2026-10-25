"use client";
import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { Mail, Plus, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActivityEntry } from "@/components/crm/activities/ActivityEntry";
import { ActivityForm } from "@/components/crm/activities/ActivityForm";
import { ComposeModal } from "@/app/[locale]/(routes)/emails/components/ComposeModal";
import { getInteractions } from "@/actions/crm/interactions/get-interactions";
import type {
  InteractionEmail,
  InteractionEntityType,
  InteractionType,
  InteractionsPage,
} from "@/actions/crm/interactions/get-interactions";

const FILTERS: { key: string; label: string; types: InteractionType[] }[] = [
  { key: "all", label: "All", types: [] },
  { key: "email", label: "Emails", types: ["email"] },
  { key: "linkedin", label: "LinkedIn", types: ["linkedin"] },
  { key: "call", label: "Calls", types: ["call"] },
  { key: "meeting", label: "Meetings", types: ["meeting", "visit"] },
  { key: "note", label: "Notes", types: ["note"] },
];

interface Props {
  entityType: InteractionEntityType;
  entityId: string;
  initialData: InteractionsPage;
  /** The viewer's mailbox; enables "Send email" when set. */
  emailAccountId?: string | null;
  /** Prefilled recipients for "Send email", comma-separated. */
  defaultEmailTo?: string;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function EmailEntry({ email, date }: { email: InteractionEmail; date: Date }) {
  const [expanded, setExpanded] = useState(false);
  const sent = email.folder === "SENT";
  return (
    <div className="flex gap-3 py-3 border-b last:border-0">
      <div className="mt-1 flex-shrink-0 text-muted-foreground">
        <Mail className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{email.subject || "(no subject)"}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge variant="outline" className="text-xs">Email</Badge>
              <Badge variant="secondary" className="text-xs">{sent ? "Sent" : "Received"}</Badge>
              <Badge variant="outline" className="text-xs">Mailbox</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {sent
                ? `To: ${email.to.join(", ")}`
                : `From: ${email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail}`}
            </p>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0" title={new Date(date).toLocaleString()}>
            {formatDistanceToNow(new Date(date), { addSuffix: true })}
          </span>
        </div>
        {email.bodyText && (
          <>
            <p
              className={`text-sm text-muted-foreground mt-1 whitespace-pre-wrap break-words ${
                expanded ? "" : "line-clamp-2"
              }`}
            >
              {email.bodyText}
            </p>
            {email.bodyText.length > 160 && (
              <button
                type="button"
                className="text-xs text-primary mt-1 hover:underline"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Show less" : "Show full content"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function InteractionsTimeline({
  entityType,
  entityId,
  initialData,
  emailAccountId,
  defaultEmailTo,
}: Props) {
  const [page, setPage] = useState(initialData);
  const [filter, setFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const typesFor = (key: string) => FILTERS.find((f) => f.key === key)?.types ?? [];

  // Activities change the summary counters too, so reload the first page.
  const reload = (key = filter) =>
    startTransition(async () => {
      setPage(await getInteractions(entityType, entityId, { types: typesFor(key) }));
    });

  const changeFilter = (key: string) => {
    setFilter(key);
    reload(key);
  };

  const loadMore = () => {
    if (!page.nextCursor) return;
    const cursor = page.nextCursor;
    startTransition(async () => {
      const next = await getInteractions(entityType, entityId, { cursor, types: typesFor(filter) });
      setPage((prev) => ({ ...next, data: [...prev.data, ...next.data] }));
    });
  };

  const { summary } = page;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
          <CardTitle className="text-base">Interactions</CardTitle>
          <div className="flex gap-2">
            {emailAccountId && (
              <ComposeModal
                accountId={emailAccountId}
                defaultTo={defaultEmailTo}
                trigger={
                  <Button size="sm" variant="outline">
                    <Send className="h-4 w-4 mr-1" />
                    Send email
                  </Button>
                }
              />
            )}
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Log interaction
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label="Last contact"
              value={
                summary.lastContactAt
                  ? formatDistanceToNow(new Date(summary.lastContactAt), { addSuffix: true })
                  : "Never"
              }
            />
            <Stat label="Emails" value={summary.emails} />
            <Stat label="LinkedIn" value={summary.linkedin} />
            <Stat label="Calls" value={summary.calls} />
            <Stat label="Meetings" value={summary.meetings} />
            <Stat
              label="Next action"
              value={
                summary.nextScheduled
                  ? `${summary.nextScheduled.title} · ${new Date(summary.nextScheduled.date).toLocaleDateString()}`
                  : "None"
              }
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? "secondary" : "ghost"}
                onClick={() => changeFilter(f.key)}
                disabled={isPending}
              >
                {f.label}
              </Button>
            ))}
          </div>

          {page.data.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No interactions yet. Log a call, LinkedIn message or email.
            </p>
          ) : (
            <div>
              {page.data.map((item) =>
                item.kind === "activity" ? (
                  <ActivityEntry
                    key={`a-${item.id}`}
                    activity={item.activity}
                    entityType={entityType}
                    entityId={entityId}
                    onDeleted={() => reload()}
                    onUpdated={() => reload()}
                  />
                ) : (
                  <EmailEntry key={`e-${item.id}`} email={item.email} date={item.date} />
                )
              )}
              {page.nextCursor && (
                <div className="flex justify-center pt-3">
                  <Button variant="ghost" size="sm" onClick={loadMore} disabled={isPending}>
                    {isPending ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>

        <ActivityForm
          open={createOpen}
          onOpenChange={setCreateOpen}
          entityType={entityType}
          entityId={entityId}
          onSaved={() => reload()}
        />
      </Card>
    </TooltipProvider>
  );
}
