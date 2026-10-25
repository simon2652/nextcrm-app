"use server";
import {
  requireAuthenticated,
  filterAuthorizedDocumentIds,
  AuthenticationError,
} from "@/lib/authz";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { deleteStoredFiles, keyFromUfsUrl } from "@/lib/uploadthing-server";

export async function bulkDeleteDocuments(documentIds: string[]) {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) throw new Error("Unauthenticated");
    throw e;
  }

  if (!documentIds || documentIds.length === 0) return;

  // Fail-closed: if any id is not authorized, reject the whole request.
  const allowed = await filterAuthorizedDocumentIds(user, documentIds);
  if (allowed.length !== documentIds.length) {
    throw new Error("Forbidden");
  }

  const documents = await prismadb.documents.findMany({
    where: { id: { in: documentIds } },
    select: { id: true, key: true, thumbnail_url: true },
  });

  // Delete from UploadThing (originals and thumbnails)
  await deleteStoredFiles(
    documents.flatMap((doc) => [doc.key, keyFromUfsUrl(doc.thumbnail_url)])
  );

  // Delete from DB (cascade handles chunks, embeddings, junction tables)
  await prismadb.documents.deleteMany({
    where: { id: { in: documentIds } },
  });

  revalidatePath("/[locale]/(routes)/documents");
}
