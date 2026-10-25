import { UTApi } from "uploadthing/server";

let client: UTApi | undefined;

/** Server-side UploadThing client. Reads UPLOADTHING_TOKEN lazily. */
export function getUtApi(): UTApi {
  if (!process.env.UPLOADTHING_TOKEN) throw new Error("UPLOADTHING_TOKEN is not defined");
  client ??= new UTApi();
  return client;
}

/** Extracts the UploadThing file key from a stored file URL (https://<app>.ufs.sh/f/<key>). */
export function keyFromUfsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Deletes files from UploadThing. Never throws: the database row is the source
 * of truth, so a storage failure is logged and must not block the caller.
 */
export async function deleteStoredFiles(keys: Array<string | null | undefined>): Promise<void> {
  const valid = keys.filter((k): k is string => Boolean(k));
  if (valid.length === 0) return;
  try {
    await getUtApi().deleteFiles(valid);
  } catch (err) {
    console.error("UploadThing deleteFiles failed:", err);
  }
}
