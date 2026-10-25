import { getUtApi } from "@/lib/uploadthing-server";

/**
 * Invoice PDFs and attachments are uploaded with a private ACL: they are only
 * reachable through short-lived signed URLs. Private files must be enabled for
 * the UploadThing app (dashboard > Settings > Files access).
 */
async function uploadPrivate(name: string, body: Buffer, mime: string): Promise<string> {
  const file = new File([new Uint8Array(body)], name, { type: mime });
  const result = await getUtApi().uploadFiles(file, { acl: "private" });
  if (result.error) throw new Error(`Invoice upload failed: ${result.error.message}`);
  return result.data.key;
}

export async function uploadInvoicePdf(invoiceId: string, pdf: Buffer): Promise<string> {
  return uploadPrivate(`invoice-${invoiceId}.pdf`, pdf, "application/pdf");
}

export async function getInvoicePdfPresignedUrl(
  key: string,
  expirySeconds = 300,
): Promise<string> {
  const { ufsUrl } = await getUtApi().generateSignedURL(key, { expiresIn: `${expirySeconds}s` });
  return ufsUrl;
}

export async function getInvoicePdfBuffer(key: string): Promise<Buffer> {
  const res = await fetch(await getInvoicePdfPresignedUrl(key, 60));
  if (!res.ok) throw new Error(`Failed to fetch invoice PDF: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadInvoiceAttachment(
  invoiceId: string,
  attachmentId: string,
  buf: Buffer,
  mime: string,
): Promise<string> {
  return uploadPrivate(`invoice-${invoiceId}-attachment-${attachmentId}`, buf, mime);
}
