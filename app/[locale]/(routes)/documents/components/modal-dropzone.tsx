"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import UploadFileModal from "@/components/modals/upload-file-modal";
import { Button } from "@/components/ui/button";
import { FileUploaderDropzone, type UploadedFileInfo } from "@/components/ui/file-uploader-dropzone";
import { createDocument } from "@/actions/documents/create-document";
import { toast } from "sonner";

type Props = {
  buttonLabel: string;
  fileType:
    | "pdfUploader"
    | "imageUploader"
    | "docUploader"
    | "profilePhotoUploader";
};

const ModalDropzone = ({ buttonLabel, fileType }: Props) => {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const handleUploadSuccess = async (url: string, key: string, file: UploadedFileInfo) => {
    try {
      await createDocument({
        name: file.name,
        url,
        key,
        size: file.size,
        mimeType: file.mimeType || "application/octet-stream",
      });
      toast.success("Document uploaded successfully");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error("Failed to save document");
    }
  };

  return (
    <div>
      <Button onClick={() => setOpen(true)}>{buttonLabel}</Button>
      <UploadFileModal isOpen={open} onClose={() => setOpen(false)}>
        <FileUploaderDropzone uploader={fileType} onUploadSuccess={handleUploadSuccess} />
      </UploadFileModal>
    </div>
  );
};

export default ModalDropzone;
