// Organization Settings: the checks shared by the forms (instant, beside the field) and the server routes (the real check before anything
// is sent on). The Organization Service repeats every one of them and is the final authority; these keep obviously bad input from travelling
// and make the normalized value (what will be saved) visible before saving. Same rules as services/organization-service/app/settings_api.py.
import { checkCompanyName, collapseSpaces } from "@/lib/setup-validation";

export type CompanyValues = {
  name: string; contact_email: string; contact_phone: string; address_street: string; address_city: string; address_state: string;
  address_postal_code: string; website: string; description: string;
};
export const COMPANY_FIELDS = ["name", "contact_email", "contact_phone", "address_street", "address_city", "address_state", "address_postal_code", "website", "description"] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];
export type FieldErrors = Partial<Record<string, string>>;

const FORBIDDEN = /[\u0000-\u001f\u007f<>]/; // control characters and angle brackets are never part of a company detail

function line(value: unknown, label: string, max: number): { ok: true; value: string } | { ok: false; message: string } {
  if (value === null || value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, message: `Enter a valid ${label}.` };
  const text = collapseSpaces(value.normalize("NFC"));
  if (FORBIDDEN.test(text)) return { ok: false, message: `The ${label} contains characters that are not allowed.` };
  if (text.length > max) return { ok: false, message: `The ${label} can be at most ${max} characters.` };
  return { ok: true, value: text };
}

export function checkEmail(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const r = line(value, "business contact e-mail", 320);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, message: "Enter the business contact e-mail." };
  const email = r.value.toLowerCase();
  if (!/^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/.test(email)) return { ok: false, message: "Enter a valid e-mail address, for example office@yourcompany.com." };
  return { ok: true, value: email };
}

export function checkPhone(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const r = line(value, "phone number", 40);
  if (!r.ok || !r.value) return r;
  if (!/^[0-9+()\-./ ]+$/.test(r.value) || (r.value.match(/[0-9]/g) ?? []).length < 5) return { ok: false, message: "Enter a phone number with digits and + ( ) - . / only, for example +92 21 1234567." };
  return r;
}

export function checkWebsite(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const r = line(value, "website", 255);
  if (!r.ok || !r.value) return r;
  const bad = { ok: false as const, message: "Enter a valid website address starting with http:// or https://, for example https://www.yourcompany.com." };
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(r.value) ? r.value : `https://${r.value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return bad;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || r.value.includes(" ") || !url.hostname.includes(".") || !/^[A-Za-z0-9.-]+$/.test(url.hostname)) return bad;
  const normalized = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  if (normalized.length > 255) return { ok: false, message: "The website address can be at most 255 characters." };
  return { ok: true, value: normalized };
}

export function checkDescription(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (value === null || value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, message: "Enter a valid description." };
  const text = value.replace(/\r\n?/g, "\n").split("\n").map((l) => collapseSpaces(l.normalize("NFC"))).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  if (/[\u0000-\u0009\u000b-\u001f\u007f<>]/.test(text)) return { ok: false, message: "The description contains characters that are not allowed." };
  if (text.length > 1000) return { ok: false, message: "The description can be at most 1000 characters." };
  return { ok: true, value: text };
}

/** The whole company form: normalized values (what the Organization Service will store) or one message per field. */
export function checkCompany(values: Partial<Record<CompanyField, unknown>>): { ok: true; value: CompanyValues } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const out = {} as CompanyValues;
  const put = (field: CompanyField, r: { ok: true; value: string } | { ok: false; message: string }) => {
    if (r.ok) out[field] = r.value;
    else errors[field] = r.message;
  };
  put("name", checkCompanyName(values.name));
  put("contact_email", checkEmail(values.contact_email));
  put("contact_phone", checkPhone(values.contact_phone));
  put("address_street", line(values.address_street, "street address", 255));
  put("address_city", line(values.address_city, "city", 120));
  put("address_state", line(values.address_state, "state or province", 120));
  put("address_postal_code", line(values.address_postal_code, "postal code", 30));
  put("website", checkWebsite(values.website));
  put("description", checkDescription(values.description));
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/** Only the fields that differ from the saved company, as the partial update to send (empty text clears an optional field). */
export function companyChanges(saved: CompanyValues, next: CompanyValues): Partial<Record<CompanyField, string | null>> {
  const out: Partial<Record<CompanyField, string | null>> = {};
  for (const field of COMPANY_FIELDS) {
    if ((saved[field] ?? "") !== next[field]) out[field] = next[field] === "" && field !== "name" && field !== "contact_email" ? null : next[field];
  }
  return out;
}
