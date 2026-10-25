import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";
import { getSession } from "@/lib/auth-server";

const f = createUploadthing();

async function requireSession() {
  const session = await getSession();
  if (!session) throw new UploadThingError("Unauthorized");
  return { userId: session.user.id };
}

const MIME_DOC = "application/msword";
const MIME_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Returned to the client once the file is stored. */
const toClientData = (file: {
  key: string;
  ufsUrl: string;
  name: string;
  size: number;
  type: string;
}) => ({
  key: file.key,
  url: file.ufsUrl,
  name: file.name,
  size: file.size,
  mimeType: file.type,
});

export const ourFileRouter = {
  profilePhotoUploader: f({ image: { maxFileSize: "4MB", maxFileCount: 1 } })
    .middleware(requireSession)
    .onUploadComplete(async ({ file }) => toClientData(file)),

  imageUploader: f({ image: { maxFileSize: "4MB", maxFileCount: 1 } })
    .middleware(requireSession)
    .onUploadComplete(async ({ file }) => toClientData(file)),

  pdfUploader: f({ pdf: { maxFileSize: "64MB", maxFileCount: 1 } })
    .middleware(requireSession)
    .onUploadComplete(async ({ file }) => toClientData(file)),

  docUploader: f({
    [MIME_DOC]: { maxFileSize: "64MB", maxFileCount: 1 },
    [MIME_DOCX]: { maxFileSize: "64MB", maxFileCount: 1 },
    text: { maxFileSize: "64MB", maxFileCount: 1 },
  })
    .middleware(requireSession)
    .onUploadComplete(async ({ file }) => toClientData(file)),

  /** Multi-file bulk upload from the documents page (any supported type). */
  documentUploader: f({
    pdf: { maxFileSize: "64MB", maxFileCount: 20 },
    image: { maxFileSize: "64MB", maxFileCount: 20 },
    text: { maxFileSize: "64MB", maxFileCount: 20 },
    [MIME_DOC]: { maxFileSize: "64MB", maxFileCount: 20 },
    [MIME_DOCX]: { maxFileSize: "64MB", maxFileCount: 20 },
  })
    .middleware(requireSession)
    .onUploadComplete(async ({ file }) => toClientData(file)),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
