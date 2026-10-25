"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import moment from "moment";
import { FolderOpen, FileUp, Loader2, RefreshCw, Trash2, ShieldAlert, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  deleteKnowledgeDocument,
  reindexKnowledge,
  saveKnowledgeFile,
  setKnowledgePinned,
  type KnowledgeDocumentRow,
} from "../actions/knowledge";

const ACCEPTED = /\.(md|markdown|txt|json)$/i;
// Folders that hold tooling rather than product knowledge are unchecked by default.
const UNCHECKED_FOLDERS = /(^|\/)(skills|node_modules|\.git|\.venv|__pycache__)(\/|$)/i;
const MAX_FILE_BYTES = 500_000;

interface PickedFile {
  path: string;
  file: File;
  selected: boolean;
}

const relativePath = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
// Drop the picked folder's own name so sources stay stable across machines.
const stripRoot = (path: string) => (path.includes("/") ? path.slice(path.indexOf("/") + 1) : path);

export function KnowledgeManager({ documents }: { documents: KnowledgeDocumentRow[] }) {
  const router = useRouter();
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(list: FileList | null) {
    const files = Array.from(list ?? [])
      .map((file) => ({ path: stripRoot(relativePath(file)), file }))
      .filter(({ path, file }) => ACCEPTED.test(path) && file.size <= MAX_FILE_BYTES)
      .map(({ path, file }) => ({
        path,
        file,
        // JSON files are only useful as confidentiality lists.
        selected: !UNCHECKED_FOLDERS.test(path) && (!/\.json$/i.test(path) || /confidential/i.test(path)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) toast.error("No .md, .txt or .json file found");
    setPicked(files);
  }

  const groups = useMemo(() => {
    const map = new Map<string, PickedFile[]>();
    for (const f of picked) {
      const folder = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
      map.set(folder, [...(map.get(folder) ?? []), f]);
    }
    return Array.from(map.entries());
  }, [picked]);

  const toggle = (paths: string[], selected: boolean) =>
    setPicked((prev) => prev.map((f) => (paths.includes(f.path) ? { ...f, selected } : f)));

  async function upload() {
    const selected = picked.filter((f) => f.selected);
    let changed = 0;
    const failures: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      setUploading(`${i + 1} / ${selected.length}`);
      const { path, file } = selected[i];
      const result = await saveKnowledgeFile({ path, content: await file.text() });
      if ("error" in result) failures.push(`${path}: ${result.error}`);
      else if (result.changed) changed++;
    }
    setUploading(null);
    setPicked([]);
    if (failures.length) toast.warning(`${failures.length} file(s) rejected — ${failures.slice(0, 2).join("; ")}`);
    toast.success(`${selected.length - failures.length} file(s) saved, ${changed} being indexed`);
    router.refresh();
  }

  const run = (action: () => Promise<object | { error: string }>, success?: string) =>
    startTransition(async () => {
      const result = await action();
      if ("error" in result) toast.error(result.error);
      else if (success) toast.success(success);
      router.refresh();
    });

  const selectedCount = picked.filter((f) => f.selected).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <input
          ref={folderInput}
          type="file"
          className="hidden"
          multiple
          // Folder picking: the browser sends every file with its relative path.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => onPick(e.target.files)}
        />
        <input ref={filesInput} type="file" className="hidden" multiple accept=".md,.markdown,.txt,.json" onChange={(e) => onPick(e.target.files)} />
        <Button variant="outline" onClick={() => folderInput.current?.click()} disabled={!!uploading}>
          <FolderOpen className="h-4 w-4 mr-2" /> Import a folder
        </Button>
        <Button variant="outline" onClick={() => filesInput.current?.click()} disabled={!!uploading}>
          <FileUp className="h-4 w-4 mr-2" /> Import files
        </Button>
        {documents.length > 0 && (
          <Button variant="ghost" disabled={pending} onClick={() => run(reindexKnowledge, "Re-indexing started")}>
            <RefreshCw className="h-4 w-4 mr-2" /> Re-index all
          </Button>
        )}
      </div>

      {picked.length > 0 && (
        <div className="rounded-md border p-4 space-y-3">
          <p className="text-sm font-medium">
            {selectedCount} of {picked.length} files selected
          </p>
          <div className="max-h-80 overflow-y-auto space-y-3">
            {groups.map(([folder, files]) => (
              <div key={folder}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={files.every((f) => f.selected) ? true : files.some((f) => f.selected) ? "indeterminate" : false}
                    onCheckedChange={(v) => toggle(files.map((f) => f.path), v === true)}
                  />
                  {folder} <span className="text-muted-foreground font-normal">({files.length})</span>
                </label>
                <div className="ml-6 mt-1 space-y-1">
                  {files.map((f) => (
                    <label key={f.path} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox checked={f.selected} onCheckedChange={(v) => toggle([f.path], v === true)} />
                      {f.path}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={upload} disabled={!!uploading || selectedCount === 0}>
              {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileUp className="h-4 w-4 mr-2" />}
              {uploading ? `Uploading ${uploading}` : `Upload ${selectedCount} files`}
            </Button>
            <Button variant="ghost" onClick={() => setPicked([])} disabled={!!uploading}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No product knowledge yet.</p>
      ) : (
        <div className="rounded-md border divide-y">
          {documents.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{d.title}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {d.source} · {Math.round(d.chars / 1000)}k chars · updated {moment(d.updatedAt).fromNow()}
                </p>
                {d.status === "FAILED" && d.error && <p className="text-xs text-destructive">{d.error}</p>}
              </div>
              {d.forbiddenCount > 0 ? (
                <Badge variant="outline" className="gap-1">
                  <ShieldAlert className="h-3 w-3" /> {d.forbiddenCount} confidential names
                </Badge>
              ) : (
                <Badge variant={d.status === "READY" ? "secondary" : d.status === "FAILED" ? "destructive" : "outline"}>
                  {d.status === "READY" ? `${d.chunkCount} excerpts` : d.status === "PENDING" ? "Indexing…" : "Failed"}
                </Badge>
              )}
              {d.forbiddenCount === 0 && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Prioritised documents win ties in retrieval">
                  <Star className="h-3.5 w-3.5" />
                  <Switch checked={d.pinned} disabled={pending} onCheckedChange={(v) => run(() => setKnowledgePinned(d.id, v))} />
                  Priority
                </label>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={pending}
                onClick={() => run(() => deleteKnowledgeDocument(d.id), "Deleted")}
                aria-label={`Delete ${d.title}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
