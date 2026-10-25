/** Outreach settings shared by the server and the UI (no server-only imports). */

export type OutreachChannel = "EMAIL" | "LINKEDIN" | "WHATSAPP";

export const OUTREACH_LANGUAGES: Record<string, string> = {
  fr: "French",
  en: "English",
  es: "Spanish",
  de: "German",
  it: "Italian",
};

/** Most targets one bulk generation request may queue. */
export const OUTREACH_BULK_MAX = 200;

/** Hard length limits checked after generation (characters). */
export const CHANNEL_MAX_CHARS: Record<OutreachChannel, number> = {
  EMAIL: 1500,
  LINKEDIN: 600,
  WHATSAPP: 450,
};
