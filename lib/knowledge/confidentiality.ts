/**
 * Confidentiality list for generated messages: names (customers, prospects,
 * competitors) that must never reach a prospect, plus the generic descriptors
 * to use instead. Same shape as the AIRFP pipeline's confidentialite.json.
 */

export interface ConfidentialityList {
  forbidden: string[];
  allowed: string[];
  descriptors: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];

/** Parse a confidentiality JSON file (French or English keys); null when it is not one. */
export function parseConfidentialityJson(raw: string): ConfidentialityList | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const forbidden = strings(data.termes_interdits ?? data.forbidden_terms);
  if (forbidden.length === 0) return null;
  return {
    forbidden,
    allowed: strings(data.noms_autorises ?? data.allowed_names),
    descriptors: strings(data.descripteurs_generiques ?? data.generic_descriptors),
  };
}

/** Markdown version stored as the knowledge document's content. */
export function confidentialityMarkdown(list: ConfidentialityList): string {
  const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    "# Confidentiality rules for prospect messages",
    "Never name a customer, prospect, partner or competitor from the list below in a message. Refer to them with a generic descriptor instead.",
    "## Forbidden names",
    bullets(list.forbidden),
    list.descriptors.length ? `## Generic descriptors to use instead\n${bullets(list.descriptors)}` : "",
    list.allowed.length ? `## Names that may be used\n${bullets(list.allowed)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Forbidden names found in a text (case- and accent-insensitive, whole words).
 * `exceptions` are names allowed for this message, e.g. the prospect's own company.
 */
export function findForbiddenTerms(text: string, forbidden: string[], exceptions: string[] = []): string[] {
  const haystack = fold(text);
  const allowed = new Set(exceptions.filter(Boolean).map(fold));
  return forbidden.filter((term) => {
    const needle = fold(term);
    if (!needle || allowed.has(needle)) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u").test(haystack);
  });
}
