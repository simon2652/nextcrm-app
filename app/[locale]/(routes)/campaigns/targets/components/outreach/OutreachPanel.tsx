"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import moment from "moment";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Linkedin,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
  UserSearch,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  deleteOutreachMessage,
  getTargetOutreach,
  markOutreachSent,
  requestOutreach,
  updateOutreachMessage,
  type OutreachMessage,
} from "@/actions/crm/targets/outreach";
import type { OutreachProfile } from "@/lib/outreach/profile";
import { CHANNEL_MAX_CHARS } from "@/lib/outreach/constants";
import { CHANNELS, OutreachComposer, type OutreachRequest } from "./OutreachComposer";

interface TargetContactInfo {
  id: string;
  first_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  social_linkedin: string | null;
}

const IN_PROGRESS: OutreachMessage["status"][] = ["PENDING", "RESEARCHING", "WRITING"];
const STATUS_LABEL: Record<OutreachMessage["status"], string> = {
  PENDING: "Queued",
  RESEARCHING: "Researching the profile…",
  WRITING: "Writing…",
  READY: "Draft",
  SENT: "Sent",
  FAILED: "Failed",
};
const POLL_MS = 3000;

function whatsappUrl(phone: string | null, text: string) {
  const digits = (phone ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function ProfileCard({ profile, profileAt }: { profile: OutreachProfile; profileAt: string | null }) {
  const { professional: p, persona } = profile;
  return (
    <div className="rounded-md border p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.currentTitle ?? "Title unknown"}</span>
        {p.company && <span className="text-muted-foreground">· {p.company}</span>}
        <Badge variant={profile.researchedWith === "web" ? "default" : "secondary"}>
          {profile.researchedWith === "web" ? "Researched on the web" : "From imported data"}
        </Badge>
        {p.linkedinUrl && (
          <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            <Linkedin className="h-3.5 w-3.5" /> Profile
          </a>
        )}
        {profileAt && <span className="text-xs text-muted-foreground">{moment(profileAt).fromNow()}</span>}
      </div>
      {p.headline && <p className="text-muted-foreground">{p.headline}</p>}
      {p.summary && <p>{p.summary}</p>}
      {p.highlights.length > 0 && (
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
          {p.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-2 pt-1">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">Persona</p>
          <p>
            {persona.roleFamily} · {persona.seniority} · {persona.decisionRole}
          </p>
          {persona.angle && <p className="text-muted-foreground mt-1">{persona.angle}</p>}
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">Likely pains</p>
          <ul className="list-disc list-inside">
            {persona.likelyPains.map((pain, i) => (
              <li key={i}>{pain}</li>
            ))}
          </ul>
        </div>
      </div>
      {profile.researchNote && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{profile.researchNote}</p>
      )}
      {profile.sources.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sources:{" "}
          {profile.sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline mr-2">
              {s.title || new URL(s.url).hostname}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

function MessageCard({
  message,
  target,
  linkedinUrl,
  onChanged,
  onRetry,
}: {
  message: OutreachMessage;
  target: TargetContactInfo;
  linkedinUrl: string | null;
  onChanged: () => void;
  onRetry: (m: OutreachMessage) => void;
}) {
  const [subject, setSubject] = useState(message.subject ?? "");
  const [body, setBody] = useState(message.body ?? "");
  const [pending, startTransition] = useTransition();
  const channel = CHANNELS.find((c) => c.value === message.channel)!;
  const Icon = channel.icon;
  const dirty = subject !== (message.subject ?? "") || body !== (message.body ?? "");
  const limit = CHANNEL_MAX_CHARS[message.channel];

  const run = (action: () => Promise<object | { error: string }>, success?: string) =>
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (success) toast.success(success);
      onChanged();
    });

  async function copy() {
    const text = message.channel === "EMAIL" && subject ? `${subject}\n\n${body}` : body;
    await navigator.clipboard.writeText(text);
    toast.success("Copied to the clipboard");
  }

  function openChannel() {
    if (message.channel === "EMAIL") {
      window.open(`mailto:${target.email ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    } else if (message.channel === "WHATSAPP") {
      window.open(whatsappUrl(target.mobile_phone, body), "_blank", "noopener");
    } else {
      // LinkedIn has no prefill URL: copy, then open the profile to paste.
      navigator.clipboard.writeText(body).then(() => toast.success("Message copied — paste it on LinkedIn"));
      if (linkedinUrl) window.open(linkedinUrl, "_blank", "noopener");
    }
  }

  const generating = IN_PROGRESS.includes(message.status);

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Icon className="h-4 w-4" />
        <span className="font-medium">{channel.label}</span>
        <Badge variant={message.status === "SENT" ? "default" : message.status === "FAILED" ? "destructive" : "secondary"}>
          {STATUS_LABEL[message.status]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {message.status === "SENT" && message.sentAt
            ? `Sent ${moment(message.sentAt).format("DD MMM YYYY HH:mm")}`
            : `Created ${moment(message.createdAt).fromNow()}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
          disabled={pending || generating}
          onClick={() => run(() => deleteOutreachMessage(message.id))}
          aria-label="Delete message"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {message.instructions && (
        <p className="text-xs text-muted-foreground">Instructions: {message.instructions}</p>
      )}

      {generating && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {STATUS_LABEL[message.status]}
        </div>
      )}

      {message.status === "FAILED" && (
        <div className="space-y-2">
          <p className="text-sm text-destructive break-words">{message.error ?? "Generation failed"}</p>
          <Button size="sm" variant="outline" onClick={() => onRetry(message)}>
            <RotateCcw className="h-4 w-4 mr-1" /> Retry
          </Button>
        </div>
      )}

      {(message.status === "READY" || message.status === "SENT") && (
        <>
          {message.warnings.length > 0 && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <div>
                {message.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            </div>
          )}
          {message.channel === "EMAIL" && (
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
          )}
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={message.channel === "EMAIL" ? 10 : 6} aria-label="Message" />
          <p className={`text-xs ${body.length > limit ? "text-destructive" : "text-muted-foreground"}`}>
            {body.length} / {limit} characters
          </p>
          <div className="flex flex-wrap gap-2">
            {dirty && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => updateOutreachMessage(message.id, { subject: subject || null, body }), "Saved")}
              >
                <Save className="h-4 w-4 mr-1" /> Save
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="h-4 w-4 mr-1" /> Copy
            </Button>
            <Button size="sm" variant="outline" onClick={openChannel} disabled={message.channel === "LINKEDIN" && !linkedinUrl}>
              <ExternalLink className="h-4 w-4 mr-1" />
              {message.channel === "EMAIL" ? "Open in mail app" : message.channel === "WHATSAPP" ? "Open WhatsApp" : "Open LinkedIn"}
            </Button>
            {message.status === "READY" ? (
              <Button size="sm" variant="outline" disabled={pending || dirty} onClick={() => run(() => markOutreachSent(message.id, true), "Marked as sent")}>
                <Check className="h-4 w-4 mr-1" /> Mark as sent
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => markOutreachSent(message.id, false))}>
                Mark as not sent
              </Button>
            )}
          </div>
          {message.knowledgeSources.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="text-xs text-muted-foreground hover:underline">
                Product knowledge used ({message.knowledgeSources.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 list-disc list-inside text-xs text-muted-foreground">
                  {message.knowledgeSources.map((s, i) => (
                    <li key={i}>
                      {s.document}
                      {s.heading ? ` — ${s.heading}` : ""}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

export function OutreachPanel({ target }: { target: TargetContactInfo }) {
  const [profile, setProfile] = useState<OutreachProfile | null>(null);
  const [profileAt, setProfileAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<OutreachMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const result = await getTargetOutreach(target.id);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setProfile(result.profile);
    setProfileAt(result.profileAt);
    setMessages(result.messages);
    setLoaded(true);
  }, [target.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const inProgress = messages.some((m) => IN_PROGRESS.includes(m.status));
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress, refresh]);

  async function generate(request: OutreachRequest) {
    setSubmitting(true);
    try {
      const result = await requestOutreach({ targetIds: [target.id], ...request });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const linkedinUrl = profile?.professional.linkedinUrl ?? target.social_linkedin;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <UserSearch className="h-5 w-5" /> AI outreach
        </CardTitle>
        <CardDescription>
          Personalised email, LinkedIn or WhatsApp message from the prospect&apos;s professional profile and your
          product knowledge.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {profile ? (
          <ProfileCard profile={profile} profileAt={profileAt} />
        ) : (
          loaded && (
            <p className="text-sm text-muted-foreground">
              The professional profile (LinkedIn, title, persona) is researched with the first message.
            </p>
          )
        )}

        {loaded && (
          <OutreachComposer onSubmit={generate} submitLabel="Generate message" busy={submitting} showRefresh={!!profile} />
        )}

        {messages.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Messages ({messages.length})</p>
            {messages.map((m) => (
              <MessageCard
                // Remount when generation finishes or the status changes, so the editor starts from the saved text.
                key={`${m.id}:${m.status}`}
                message={m}
                target={target}
                linkedinUrl={linkedinUrl}
                onChanged={refresh}
                onRetry={(failed) =>
                  generate({
                    channel: failed.channel,
                    language: failed.language,
                    instructions: failed.instructions ?? "",
                    refreshProfile: false,
                  })
                }
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
