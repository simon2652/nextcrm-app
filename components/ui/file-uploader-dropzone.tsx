"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { Loader2, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUploadThing } from "@/lib/uploadthing";

type UploaderEndpoint =
  | "pdfUploader"
  | "imageUploader"
  | "docUploader"
  | "profilePhotoUploader";

export type UploadedFileInfo = {
  url: string;
  key: string;
  name: string;
  size: number;
  mimeType: string;
};

interface Props {
  uploader: UploaderEndpoint;
  onUploadSuccess?: (url: string, key: string, file: UploadedFileInfo) => void;
}

const UPLOADER_CONFIG: Record<
  UploaderEndpoint,
  { accept: Record<string, string[]>; maxSizeMB: number }
> = {
  profilePhotoUploader: { accept: { "image/*": [] }, maxSizeMB: 4 },
  imageUploader: { accept: { "image/*": [] }, maxSizeMB: 4 },
  pdfUploader: { accept: { "application/pdf": [".pdf"] }, maxSizeMB: 64 },
  docUploader: {
    accept: {
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "text/plain": [".txt"],
    },
    maxSizeMB: 64,
  },
};

export const FileUploaderDropzone = ({ uploader, onUploadSuccess }: Props) => {
  const config = UPLOADER_CONFIG[uploader];
  const [uploading, setUploading] = useState(false);

  const { startUpload } = useUploadThing(uploader, {
    onUploadError: (err) => {
      toast.error(`Upload error: ${err.message}`);
    },
  });

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;
      setUploading(true);
      try {
        const res = await startUpload(acceptedFiles.slice(0, 1));
        const data = res?.[0]?.serverData;
        if (data) onUploadSuccess?.(data.url, data.key, data);
      } finally {
        setUploading(false);
      }
    },
    [startUpload, onUploadSuccess]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    maxSize: config.maxSizeMB * 1024 * 1024,
    accept: config.accept,
    disabled: uploading,
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors",
        isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50",
        uploading && "opacity-60 cursor-not-allowed"
      )}
    >
      <input {...getInputProps()} />
      {uploading ? (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Uploading...</p>
        </>
      ) : (
        <>
          <UploadCloud className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {isDragActive ? "Drop file here" : "Drag & drop or click to upload"}
          </p>
          <p className="text-xs text-muted-foreground/60">Max {config.maxSizeMB}MB</p>
        </>
      )}
    </div>
  );
};
