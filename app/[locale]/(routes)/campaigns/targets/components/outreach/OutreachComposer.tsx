"use client";

import { useState } from "react";
import { Linkedin, Mail, MessageCircle, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { OUTREACH_LANGUAGES, type OutreachChannel } from "@/lib/outreach/constants";

export interface OutreachRequest {
  channel: OutreachChannel;
  language: string;
  instructions: string;
  refreshProfile: boolean;
}

export const CHANNELS: Array<{ value: OutreachChannel; label: string; icon: typeof Mail }> = [
  { value: "EMAIL", label: "Email", icon: Mail },
  { value: "LINKEDIN", label: "LinkedIn", icon: Linkedin },
  { value: "WHATSAPP", label: "WhatsApp", icon: MessageCircle },
];

const LANGUAGE_LABELS: Record<string, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
};

// Per-viewer convenience: the last settings are prefilled on the next lead.
const STORAGE_KEY = "nextcrm.outreach.composer";

function loadSaved(): Partial<OutreachRequest> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

interface Props {
  onSubmit: (request: OutreachRequest) => Promise<void> | void;
  submitLabel: string;
  busy?: boolean;
  /** Offer to redo the LinkedIn / web research (single target only). */
  showRefresh?: boolean;
}

/** Client-only (rendered after mount or in a dialog), so the saved settings can seed the state. */
export function OutreachComposer({ onSubmit, submitLabel, busy, showRefresh }: Props) {
  const [saved] = useState(loadSaved);
  const [channel, setChannel] = useState<OutreachChannel>(saved.channel ?? "EMAIL");
  const [language, setLanguage] = useState(saved.language && saved.language in OUTREACH_LANGUAGES ? saved.language : "fr");
  const [instructions, setInstructions] = useState(typeof saved.instructions === "string" ? saved.instructions : "");
  const [refreshProfile, setRefreshProfile] = useState(false);

  async function submit() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ channel, language, instructions }));
    } catch {
      // storage unavailable: settings are simply not remembered
    }
    await onSubmit({ channel, language, instructions, refreshProfile });
    setRefreshProfile(false);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Channel</Label>
        <div className="grid grid-cols-3 gap-2">
          {CHANNELS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setChannel(value)}
              aria-pressed={channel === value}
              className={cn(
                "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                channel === value ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="outreach-language">Language</Label>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger id="outreach-language" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(OUTREACH_LANGUAGES).map((code) => (
              <SelectItem key={code} value={code}>
                {LANGUAGE_LABELS[code] ?? code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="outreach-instructions">Instructions for the AI</Label>
        <Textarea
          id="outreach-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="e.g. Mention our webinar on 12 November, focus on Go/No-Go decisions, informal tone, LinkedIn connection note under 300 characters…"
        />
        <p className="text-xs text-muted-foreground">
          The message is built from the prospect&apos;s professional profile (LinkedIn first) and the product
          knowledge base. Your instructions take precedence over the default style.
        </p>
      </div>

      {showRefresh && (
        <div className="flex items-center gap-2">
          <Switch id="outreach-refresh" checked={refreshProfile} onCheckedChange={setRefreshProfile} />
          <Label htmlFor="outreach-refresh" className="font-normal">
            Redo the profile research
          </Label>
        </div>
      )}

      <Button onClick={submit} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
        {submitLabel}
      </Button>
    </div>
  );
}
