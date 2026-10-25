// The importable crm_Opportunities fields, plus the account / contact columns
// used to find-or-create the related records. Shared by the import modal and
// the server action so both validate the same keys.
export interface OpportunityField {
  key: string;
  label: string;
  required: boolean;
}

export const OPPORTUNITY_FIELDS: OpportunityField[] = [
  { key: "name", label: "Opportunity Name", required: true },
  { key: "budget", label: "Budget", required: false },
  { key: "expected_revenue", label: "Expected Revenue", required: false },
  { key: "currency", label: "Currency (ISO code)", required: false },
  { key: "close_date", label: "Close Date", required: false },
  { key: "sales_stage", label: "Sales Stage (name)", required: false },
  { key: "description", label: "Description", required: false },
  { key: "next_step", label: "Next Step", required: false },
  { key: "account_name", label: "Account / Company", required: false },
  { key: "contact_first_name", label: "Contact First Name", required: false },
  { key: "contact_last_name", label: "Contact Last Name", required: false },
  { key: "contact_email", label: "Contact Email", required: false },
];

export const OPPORTUNITY_IMPORT_MAX_ROWS = 500;
