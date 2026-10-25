/**
 * Heading-aware Markdown chunking for the product knowledge base.
 *
 * Each chunk keeps the heading path it belongs to ("Messaging > Personas >
 * CRO"), so retrieval can hand the writer a self-explanatory excerpt.
 */

export interface KnowledgeChunk {
  heading: string | null;
  content: string;
}

export const MAX_CHUNK_CHARS = 1800;
const MIN_CHUNK_CHARS = 200;

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

function splitLongText(text: string, max: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > max) {
      if (current) parts.push(current);
      current = "";
      for (let i = 0; i < paragraph.length; i += max) parts.push(paragraph.slice(i, i + max));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > max) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkMarkdown(markdown: string, maxChars = MAX_CHUNK_CHARS): KnowledgeChunk[] {
  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  const path: string[] = [];
  let inFence = false;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence ? HEADING_RE.exec(line) : null;
    if (match) {
      const level = match[1].length;
      path.length = level - 1;
      path[level - 1] = match[2].replace(/[*_`]/g, "").trim();
      sections.push({ heading: path.filter(Boolean).join(" > "), lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    const previous = chunks[chunks.length - 1];
    // Fold a tiny section into the previous chunk instead of indexing a crumb.
    if (previous && text.length < MIN_CHUNK_CHARS && previous.content.length + text.length < maxChars) {
      previous.content += `\n\n${section.heading ? `${section.heading.split(" > ").pop()}\n` : ""}${text}`;
      continue;
    }
    for (const part of splitLongText(text, maxChars)) {
      chunks.push({ heading: section.heading, content: part });
    }
  }
  return chunks;
}
