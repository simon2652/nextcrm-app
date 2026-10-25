"use client";
import { useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createActivity } from "@/actions/crm/activities/create-activity";
import { updateActivity } from "@/actions/crm/activities/update-activity";
import type { ActivityWithLinks } from "@/actions/crm/activities/get-activities-by-entity";

type ActivityType = "call" | "meeting" | "note" | "email" | "visit" | "linkedin";
type ActivityStatus = "scheduled" | "completed" | "cancelled";
type Direction = "outbound" | "inbound";

const DEFAULT_STATUS: Record<ActivityType, ActivityStatus> = {
  call: "scheduled",
  meeting: "scheduled",
  note: "completed",
  email: "completed",
  visit: "scheduled",
  linkedin: "completed",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: string;
  entityId: string;
  activity?: ActivityWithLinks; // if provided: edit mode
  onSaved: (activity: ActivityWithLinks) => void;
}

export function ActivityForm({ open, onOpenChange, entityType, entityId, activity, onSaved }: Props) {
  const isEdit = !!activity;

  const [type, setType] = useState<ActivityType>(activity?.type ?? "call");
  const [title, setTitle] = useState(activity?.title ?? "");
  const [description, setDescription] = useState(activity?.description ?? "");
  const [date, setDate] = useState(
    activity ? new Date(activity.date).toISOString().slice(0, 16) : ""
  );
  const [status, setStatus] = useState<ActivityStatus>(activity?.status ?? "scheduled");
  const [duration, setDuration] = useState(activity?.duration?.toString() ?? "");
  const [outcome, setOutcome] = useState(activity?.outcome ?? "");
  const existingMetadata = (activity?.metadata as Record<string, unknown> | null) ?? {};
  const [emailSubject, setEmailSubject] = useState(
    (existingMetadata.subject as string | undefined) ?? ""
  );
  const [direction, setDirection] = useState<Direction>(
    (existingMetadata.direction as Direction | undefined) ?? "outbound"
  );
  const [recipient, setRecipient] = useState((existingMetadata.to as string | undefined) ?? "");
  const [isFollowUp, setIsFollowUp] = useState(existingMetadata.isFollowUp === true);
  const [saving, setSaving] = useState(false);

  // Auto-set status when type changes (only in create mode)
  const handleTypeChange = (newType: ActivityType) => {
    setType(newType);
    if (!isEdit) {
      setStatus(DEFAULT_STATUS[newType]);
    }
  };

  const showDuration = type === "call" || type === "meeting" || type === "visit";
  const showOutcome = type === "call" || type === "meeting" || type === "visit";
  const showEmailSubject = type === "email";
  const isMessage = type === "email" || type === "linkedin";
  const showDirection = isMessage || type === "call";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!date) {
      toast.error("Date is required");
      return;
    }

    setSaving(true);

    // Start from stored metadata so keys set elsewhere (e.g. calendar sync) survive edits.
    const metadata: Record<string, unknown> = { ...existingMetadata };
    delete metadata.subject;
    delete metadata.direction;
    delete metadata.to;
    delete metadata.isFollowUp;
    if (showEmailSubject && emailSubject) metadata.subject = emailSubject;
    if (showDirection) metadata.direction = direction;
    if (isMessage && recipient.trim()) metadata.to = recipient.trim();
    if (isFollowUp) metadata.isFollowUp = true;

    const payload = {
      type,
      title: title.trim(),
      description: description.trim() || undefined,
      date: new Date(date),
      duration: showDuration && duration ? parseInt(duration, 10) : undefined,
      outcome: showOutcome && outcome.trim() ? outcome.trim() : undefined,
      status,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      // Editing keeps the original links: the interaction feed shows activities
      // logged on a deal's contacts, which must not be re-linked to the deal.
      links: isEdit
        ? activity.links.map(({ entityType, entityId }) => ({ entityType, entityId }))
        : [{ entityType, entityId }],
    };

    let result: { data?: ActivityWithLinks; error?: string };

    if (isEdit) {
      result = await updateActivity({ id: activity.id, ...payload });
    } else {
      result = await createActivity(payload);
    }

    setSaving(false);

    if (result.error) {
      toast.error(result.error);
    } else if (result.data) {
      toast.success(isEdit ? "Activity updated" : "Activity logged");
      onSaved(result.data as ActivityWithLinks);
      onOpenChange(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit Activity" : "Log Activity"}</SheetTitle>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="space-y-1">
            <Label htmlFor="activity-type">Type</Label>
            <Select value={type} onValueChange={(v) => handleTypeChange(v as ActivityType)}>
              <SelectTrigger id="activity-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="call">Call</SelectItem>
                <SelectItem value="meeting">Meeting</SelectItem>
                <SelectItem value="visit">Visit</SelectItem>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="linkedin">LinkedIn message</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="activity-title">Title *</Label>
            <Input
              id="activity-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief description"
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="activity-date">Date & Time *</Label>
            <Input
              id="activity-date"
              type="datetime-local"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="activity-status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as ActivityStatus)}>
              <SelectTrigger id="activity-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {showDirection && (
            <div className="space-y-1">
              <Label htmlFor="activity-direction">Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
                <SelectTrigger id="activity-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">{type === "call" ? "Outgoing call" : "Sent"}</SelectItem>
                  <SelectItem value="inbound">{type === "call" ? "Incoming call" : "Received"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {isMessage && (
            <div className="space-y-1">
              <Label htmlFor="activity-recipient">
                {direction === "outbound" ? "To" : "From"}
              </Label>
              <Input
                id="activity-recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={type === "linkedin" ? "LinkedIn profile or name" : "name@company.com"}
              />
            </div>
          )}

          {showDuration && (
            <div className="space-y-1">
              <Label htmlFor="activity-duration">Duration (minutes)</Label>
              <Input
                id="activity-duration"
                type="number"
                min="1"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="e.g. 30"
              />
            </div>
          )}

          {showOutcome && (
            <div className="space-y-1">
              <Label htmlFor="activity-outcome">Outcome</Label>
              <Input
                id="activity-outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                placeholder="Result of the call / meeting"
              />
            </div>
          )}

          {showEmailSubject && (
            <div className="space-y-1">
              <Label htmlFor="activity-email-subject">Email Subject</Label>
              <Input
                id="activity-email-subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Subject line"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="activity-description">
              {isMessage ? "Message content" : "Notes"}
            </Label>
            <Textarea
              id="activity-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isMessage ? "Paste the full message..." : "Additional notes..."}
              rows={isMessage ? 8 : 4}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="activity-follow-up"
              checked={isFollowUp}
              onCheckedChange={(checked) => setIsFollowUp(checked === true)}
            />
            <Label htmlFor="activity-follow-up" className="font-normal">
              Follow-up
            </Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : isEdit ? "Save changes" : "Log activity"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
