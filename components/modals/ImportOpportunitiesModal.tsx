"use client";

import { importOpportunities } from "@/actions/crm/opportunities/import-opportunities";
import { OPPORTUNITY_FIELDS } from "@/lib/spreadsheet/opportunity-fields";
import SpreadsheetImportModal from "./SpreadsheetImportModal";

const ImportOpportunitiesModal = () => (
  <SpreadsheetImportModal
    title="Opportunities"
    fields={OPPORTUNITY_FIELDS}
    requiredHint="name is required per row. Accounts are matched by name and contacts by email; missing ones are created."
    validateRow={(row) => (!row.name?.trim() ? "missing Opportunity Name" : null)}
    importAction={importOpportunities}
    suggestWithFields
  />
);

export default ImportOpportunitiesModal;
