import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { getUtApi } from "@/lib/uploadthing-server";
import sharp from "sharp";

const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 200;

async function fetchFileBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export const generateDocumentThumbnail = inngest.createFunction(
  {
    id: "document-generate-thumbnail",
    name: "Generate Document Thumbnail",
    triggers: [{ event: "document/uploaded" }],
    retries: 2,
  },
  async ({ event }) => {
    const { documentId } = event.data as { documentId: string };

    const document = await prismadb.documents.findUnique({
      where: { id: documentId },
      select: { id: true, key: true, document_file_url: true, document_file_mimeType: true },
    });
    if (!document?.key) return { skipped: "no key" };

    const isImage = document.document_file_mimeType.startsWith("image/");
    if (!isImage) {
      // For non-image files (PDF, DOCX), skip thumbnail for now.
      return { skipped: "non-image file" };
    }

    const buffer = await fetchFileBuffer(document.document_file_url);
    const thumbnail = await sharp(buffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover" })
      .png()
      .toBuffer();

    const upload = await getUtApi().uploadFiles(
      new File([new Uint8Array(thumbnail)], `thumbnail-${documentId}.png`, { type: "image/png" })
    );
    if (upload.error) throw new Error(`Thumbnail upload failed: ${upload.error.message}`);
    const thumbnailUrl = upload.data.ufsUrl;

    await prismadb.documents.update({
      where: { id: documentId },
      data: { thumbnail_url: thumbnailUrl },
    });

    return { documentId, thumbnailUrl };
  }
);
