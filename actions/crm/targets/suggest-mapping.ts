"use server";
import { getSession } from "@/lib/auth-server";
import { aiRouter } from "@/lib/llm/ai-router";

const TARGET_FIELDS = [
  "last_name",
  "first_name",
  "email",
  "mobile_phone",
  "office_phone",
  "company",
  "position",
  "company_website",
  "personal_website",
  "social_linkedin",
  "social_x",
  "social_instagram",
  "social_facebook",
  "personal_email",
  "company_email",
  "company_phone",
  "city",
  "country",
  "industry",
  "employees",
  "description",
];

function fuzzyMatch(header: string): string | null {
  const normalized = header.toLowerCase().replace(/[\s_\-]/g, "");
  for (const field of TARGET_FIELDS) {
    if (field.replace(/_/g, "") === normalized) return field;
  }
  const aliases: Record<string, string> = {
    lastname: "last_name",
    surname: "last_name",
    familyname: "last_name",
    firstname: "first_name",
    givenname: "first_name",
    name: "first_name",
    mail: "email",
    emailaddress: "email",
    phone: "mobile_phone",
    mobile: "mobile_phone",
    cellphone: "mobile_phone",
    mobilephone: "mobile_phone",
    officephone: "office_phone",
    workphone: "office_phone",
    businessphone: "office_phone",
    companyname: "company",
    organization: "company",
    organisation: "company",
    jobtitle: "position",
    title: "position",
    role: "position",
    website: "company_website",
    companywebsite: "company_website",
    personalwebsite: "personal_website",
    linkedin: "social_linkedin",
    linkedinurl: "social_linkedin",
    twitter: "social_x",
    x: "social_x",
    "x/twitter": "social_x",
    instagram: "social_instagram",
    facebook: "social_facebook",
    personalemail: "personal_email",
    directemail: "personal_email",
    myemail: "personal_email",
    companyemail: "company_email",
    infoemail: "company_email",
    contactemail: "company_email",
    genericemail: "company_email",
    companyphone: "company_phone",
    mainphone: "company_phone",
    switchboard: "company_phone",
    hqphone: "company_phone",
    hqcity: "city",
    headquarterscity: "city",
    hqcountry: "country",
    nation: "country",
    sector: "industry",
    vertical: "industry",
    businesstype: "industry",
    headcount: "employees",
    numemployees: "employees",
    teamsize: "employees",
    companysize: "employees",
    about: "description",
    bio: "description",
    summary: "description",
    companydescription: "description",
  };
  return aliases[normalized] ?? null;
}

/**
 * Suggest a { csvHeader -> crmField } mapping. `fields` defaults to the target
 * fields; other importers (e.g. opportunities) pass their own field keys.
 */
export const suggestMapping = async (headers: string[], fields?: string[]) => {
  const session = await getSession();
  if (!session) return { error: "Unauthorized" };

  if (!Array.isArray(headers)) return { error: "Invalid request" };
  if (fields !== undefined && (!Array.isArray(fields) || fields.some((k) => typeof k !== "string"))) {
    return { error: "Invalid request" };
  }
  const crmFields = fields ?? TARGET_FIELDS;

  const userId = (session.user as any).id;
  try {
    const result = await aiRouter.generateContent(
      "You are a data mapping assistant. Given a list of CSV column headers and a list of CRM field names, return a JSON object mapping each CSV header to the best matching CRM field, or null if no match. Only use the provided CRM field names as values. Return only valid JSON, no explanation.",
      `CSV headers: ${JSON.stringify(headers)}\n\nCRM fields: ${JSON.stringify(crmFields)}\n\nReturn a JSON object like: { "CSV Header": "crm_field" or null }`,
      { tier: "light", responseFormat: "json", temperature: 0 },
      { userId, procedure: "crm.import.suggestMapping" }
    );
    const parsed = JSON.parse(result.text);
    const mapping: Record<string, string | null> = {};
    for (const header of headers) {
      const suggested = parsed[header];
      mapping[header] = suggested && crmFields.includes(suggested) ? suggested : null;
    }
    return { mapping };
  } catch (err) {
    // No provider configured, or every provider failed: fuzzy matching still works.
    console.error("LLM mapping failed, falling back to fuzzy match", err);
  }

  // Fallback: fuzzy match
  const mapping: Record<string, string | null> = {};
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, "");
  for (const header of headers) {
    mapping[header] = fields
      ? crmFields.find((k) => normalize(k) === normalize(header)) ?? null
      : fuzzyMatch(header);
  }
  return { mapping };
};
