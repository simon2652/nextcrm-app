"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { suggestMapping } from "@/actions/crm/targets/suggest-mapping";
import { parseSpreadsheetFile } from "@/lib/spreadsheet/parse";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Upload, Loader2 } from "lucide-react";

type Step = "upload" | "mapping" | "preview";

const SKIP_VALUE = "__skip__";

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
}

interface Props {
  /** Entity name in the title, e.g. "Targets". */
  title: string;
  fields: ImportField[];
  /** Footnote under the mapping table, e.g. which fields are required. */
  requiredHint: string;
  /** Returns a skip reason for a mapped row, or null when it can be imported. */
  validateRow: (row: Record<string, string>) => string | null;
  importAction: (formData: FormData) => Promise<{ imported: number; skipped: number; errors: string[] }>;
  /** Pass the field keys to suggestMapping (the default list is the target fields). */
  suggestWithFields?: boolean;
  /**
   * Batched import of the mapped rows (used instead of importAction when set):
   * large files go up in chunks, under the server action body limit.
   */
  importRows?: (
    rows: Record<string, string>[],
    ctx: { listId: string | null; dedupe: boolean; firstRowNumber: number }
  ) => Promise<{ imported: number; skipped: number; errors: string[]; duplicates?: number }>;
  /** Offer to put the imported rows in a new list; resolves to the list id. */
  createList?: (name: string) => Promise<string>;
  /** Offer to skip rows whose email already exists. */
  dedupeOption?: boolean;
}

const IMPORT_BATCH_ROWS = 500;

const SpreadsheetImportModal = ({
  title,
  fields,
  requiredHint,
  validateRow,
  importAction,
  suggestWithFields = false,
  importRows,
  createList,
  dedupeOption = false,
}: Props) => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  // mapping: targetField -> csvHeader (or SKIP_VALUE)
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [addToList, setAddToList] = useState(true);
  const [listName, setListName] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);

  const resetState = () => {
    setStep("upload");
    setSelectedFile(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setIsLoading(false);
    setIsSuggesting(false);
    setAddToList(true);
    setListName("");
    setDedupe(true);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (val: boolean) => {
    setOpen(val);
    if (!val) resetState();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setListName(`${file.name.replace(/\.[^.]+$/, "")} — ${new Date().toISOString().slice(0, 10)}`);
    try {
      const rows = await parseSpreadsheetFile(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      setCsvHeaders(headers);
      setCsvRows(rows);
      fetchSuggestedMapping(headers);
    } catch {
      toast.error("Could not parse the selected file.");
    }
  };

  const fetchSuggestedMapping = useCallback(async (headers: string[]) => {
    setIsSuggesting(true);
    setStep("mapping");
    try {
      const res = await suggestMapping(
        headers,
        suggestWithFields ? fields.map((f) => f.key) : undefined
      );
      const suggested: Record<string, string | null> = res.mapping ?? {};
      // Convert from { csvHeader -> targetField } to { targetField -> csvHeader }
      const newMapping: Record<string, string> = {};
      for (const field of fields) {
        newMapping[field.key] = SKIP_VALUE;
      }
      for (const [csvHeader, targetField] of Object.entries(suggested)) {
        if (targetField && newMapping[targetField] === SKIP_VALUE) {
          newMapping[targetField] = csvHeader;
        }
      }
      setMapping(newMapping);
    } catch {
      // Set all to skip on error
      const newMapping: Record<string, string> = {};
      for (const field of fields) {
        newMapping[field.key] = SKIP_VALUE;
      }
      setMapping(newMapping);
    } finally {
      setIsSuggesting(false);
    }
  }, [fields, suggestWithFields]);

  const computePreview = () => {
    let valid = 0;
    let skipped = 0;
    const skipReasons: string[] = [];

    for (let i = 0; i < csvRows.length; i++) {
      const raw = csvRows[i];
      const row: Record<string, string> = {};
      for (const field of fields) {
        const csvCol = mapping[field.key];
        if (csvCol && csvCol !== SKIP_VALUE) {
          row[field.key] = raw[csvCol] ?? "";
        }
      }

      const reason = validateRow(row);
      if (reason) {
        skipped++;
        if (skipReasons.length < 3) skipReasons.push(`Row ${i + 2}: ${reason}`);
        continue;
      }
      valid++;
    }

    return { valid, skipped, skipReasons };
  };

  const mappedRows = () =>
    csvRows.map((raw) => {
      const row: Record<string, string> = {};
      for (const field of fields) {
        const csvCol = mapping[field.key];
        if (csvCol && csvCol !== SKIP_VALUE && raw[csvCol] != null) row[field.key] = String(raw[csvCol]);
      }
      return row;
    });

  const handleBatchedImport = async () => {
    if (!importRows) return;
    setIsLoading(true);
    try {
      const listId = createList && addToList && listName.trim() ? await createList(listName.trim()) : null;
      const rows = mappedRows();
      const total = { imported: 0, skipped: 0, duplicates: 0, errors: [] as string[] };
      for (let start = 0; start < rows.length; start += IMPORT_BATCH_ROWS) {
        setProgress(`${Math.min(start + IMPORT_BATCH_ROWS, rows.length)} / ${rows.length} rows`);
        const result = await importRows(rows.slice(start, start + IMPORT_BATCH_ROWS), {
          listId,
          dedupe: dedupeOption && dedupe,
          firstRowNumber: start + 2,
        });
        total.imported += result.imported;
        total.skipped += result.skipped;
        total.duplicates += result.duplicates ?? 0;
        total.errors.push(...result.errors);
      }
      toast.success(
        `Imported: ${total.imported}, Skipped: ${total.skipped}` +
          (total.duplicates ? `, Already in the CRM: ${total.duplicates}` : "") +
          (total.errors.length > 0 ? `. Errors: ${total.errors.slice(0, 3).join("; ")}` : "")
      );
      setOpen(false);
      resetState();
      if (listId) router.push(`/campaigns/target-lists/${listId}`);
      else router.refresh();
    } catch (error: any) {
      toast.error(error?.message || "Something went wrong");
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };

  const handleImport = async () => {
    if (importRows) return handleBatchedImport();
    if (!selectedFile) return;
    setIsLoading(true);

    // Build mapping as { csvHeader -> targetField } for the API
    const apiMapping: Record<string, string> = {};
    for (const [targetField, csvCol] of Object.entries(mapping)) {
      if (csvCol && csvCol !== SKIP_VALUE) {
        apiMapping[csvCol] = targetField;
      }
    }

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("mapping", JSON.stringify(apiMapping));

    try {
      const { imported, skipped, errors } = await importAction(formData);
      toast.success(`Imported: ${imported}, Skipped: ${skipped}${errors.length > 0 ? `. Errors: ${errors.slice(0, 3).join("; ")}` : ""}`);
      setOpen(false);
      resetState();
      router.refresh();
    } catch (error: any) {
      toast.error(error?.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const preview = step === "preview" ? computePreview() : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="h-4 w-4 mr-2" />
          Import CSV / Excel
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Import {title}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              Step {step === "upload" ? 1 : step === "mapping" ? 2 : 3} of 3
            </span>
          </DialogTitle>
          <DialogDescription>
            {step === "upload" && `Select a CSV or Excel (.xlsx) file to import ${title.toLowerCase()}.`}
            {step === "mapping" && "Map your CSV columns to CRM fields. AI has pre-filled suggestions — adjust as needed."}
            {step === "preview" && "Review the import summary before proceeding."}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Upload */}
        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="border-2 border-dashed rounded-md p-8 text-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx"
                onChange={handleFileChange}
                className="hidden"
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                Select file
              </Button>
              {selectedFile && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Selected: {selectedFile.name}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Map Columns */}
        {step === "mapping" && (
          <div className="space-y-3 py-2">
            {isSuggesting ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>AI is suggesting column mappings…</span>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground px-1 pb-1">
                  <span>CRM Field</span>
                  <span>CSV Column</span>
                </div>
                {fields.map((field) => (
                  <div key={field.key} className="grid grid-cols-2 gap-2 items-center">
                    <span className="text-sm">
                      {field.label}
                      {field.required && (
                        <span className="text-destructive ml-1">*</span>
                      )}
                    </span>
                    <Select
                      value={mapping[field.key] ?? SKIP_VALUE}
                      onValueChange={(val) =>
                        setMapping((prev) => ({ ...prev, [field.key]: val }))
                      }
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="— skip —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP_VALUE}>— skip —</SelectItem>
                        {csvHeaders.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground pt-1">
                  <span className="text-destructive">*</span> {requiredHint}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Preview */}
        {step === "preview" && preview && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border p-4 space-y-1">
              <p className="text-sm font-medium">
                Ready to import{" "}
                <span className="text-green-600 dark:text-green-400">
                  {preview.valid} row{preview.valid !== 1 ? "s" : ""}
                </span>
                {preview.skipped > 0 && (
                  <>
                    {" "}— {" "}
                    <span className="text-yellow-600 dark:text-yellow-400">
                      {preview.skipped} row{preview.skipped !== 1 ? "s" : ""} will be skipped
                    </span>
                  </>
                )}
                .
              </p>
              {preview.skipReasons.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5 pt-1">
                  {preview.skipReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                  {preview.skipped > preview.skipReasons.length && (
                    <li>…and {preview.skipped - preview.skipReasons.length} more</li>
                  )}
                </ul>
              )}
            </div>
            {preview.valid === 0 && (
              <p className="text-sm text-destructive">
                No valid rows to import. Go back and adjust your column mapping.
              </p>
            )}
            {preview.valid > 0 && (createList || dedupeOption) && (
              <div className="space-y-3 rounded-md border p-4">
                {createList && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={addToList} onCheckedChange={(v) => setAddToList(v === true)} />
                      Put the imported rows in a new list (to process them one by one)
                    </label>
                    {addToList && (
                      <Input
                        value={listName}
                        onChange={(e) => setListName(e.target.value)}
                        placeholder="List name"
                        aria-label="List name"
                        maxLength={120}
                      />
                    )}
                  </div>
                )}
                {dedupeOption && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={dedupe} onCheckedChange={(v) => setDedupe(v === true)} />
                    Skip rows whose email is already in the CRM (they are still added to the list)
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex gap-2 sm:gap-0">
          {step === "upload" && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
          )}

          {step === "mapping" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button
                onClick={() => setStep("preview")}
                disabled={isSuggesting}
              >
                Next
              </Button>
            </>
          )}

          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("mapping")} disabled={isLoading}>
                Back
              </Button>
              <Button
                onClick={handleImport}
                disabled={isLoading || !preview || preview.valid === 0}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {progress ? `Importing ${progress}…` : "Importing…"}
                  </>
                ) : (
                  "Import"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SpreadsheetImportModal;
