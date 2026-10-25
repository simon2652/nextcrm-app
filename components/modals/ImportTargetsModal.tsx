"use client";

import { importTargets, importTargetRows } from "@/actions/crm/targets/import-targets";
import { createTargetList } from "@/actions/crm/target-lists/create-target-list";
import { TARGET_FIELDS } from "@/lib/spreadsheet/target-fields";
import SpreadsheetImportModal from "./SpreadsheetImportModal";

const ImportTargetsModal = () => (
  <SpreadsheetImportModal
    title="Targets"
    fields={TARGET_FIELDS}
    requiredHint="last_name or company is required per row."
    validateRow={(row) => (!row.last_name && !row.company ? "missing Last Name or Company" : null)}
    importAction={importTargets}
    // Lead-tool exports (Apollo…) can hold thousands of rows: import in batches.
    importRows={(rows, ctx) => importTargetRows({ rows, ...ctx })}
    createList={async (name) => {
      const result = await createTargetList({ name, description: "Imported from a spreadsheet" });
      if (!("data" in result) || !result.data) throw new Error(result.error ?? "Could not create the list");
      return result.data.id;
    }}
    dedupeOption
  />
);

export default ImportTargetsModal;
