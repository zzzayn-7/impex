import { NextRequest, NextResponse } from "next/server";

import { EMAIL_RE, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

const FIELDS: [string, string, number][] = [
  ["name", "name", 255], ["code", "code", 32], ["contactPerson", "contact_person", 255], ["email", "email", 320], ["phone", "phone", 50],
  ["address", "address", 500], ["countryCode", "country_code", 2], ["taxIdentifier", "tax_identifier", 50],
];

// One supplier (the details view).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Supplier not found.", 404);
  const result = await purchasingRequest("GET", `/api/v1/purchasing/suppliers/${params.id}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Supplier not found.");
  return NextResponse.json({ supplier: result.data }, { headers: NO_STORE });
}

// EDIT a supplier (only the fields that are sent). Suppliers are deactivated, never deleted.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Supplier not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, string> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [field, apiName, max] of FIELDS) {
    const value = text(body[field]);
    if (value === undefined) continue;
    let clean = field === "name" ? collapse(value) : value;
    if (field === "code" || field === "countryCode") clean = clean.toUpperCase();
    if (field === "name" && !clean) fieldErrors.name = "Enter the supplier's name.";
    else if (clean.length > max) fieldErrors[field] = `Use ${max} characters or fewer.`;
    else if (field === "email" && clean && !EMAIL_RE.test(clean)) fieldErrors.email = "Enter a valid e-mail address.";
    else if (field === "countryCode" && clean && !/^[A-Z]{2}$/.test(clean)) fieldErrors.countryCode = "Use the 2-letter country code, e.g. DE, PK, US.";
    else if (field === "code" && clean && !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(clean)) fieldErrors.code = "Letters, digits and . _ - only (max 32).";
    change[apiName] = clean;
  }
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await purchasingRequest("PATCH", `/api/v1/purchasing/suppliers/${params.id}`, token, change);
  if (result?.status === 409 && typeof result.data?.detail === "string") {
    const detail: string = result.data.detail;
    return fail(detail, 409, { fieldErrors: detail.includes("code") ? { code: detail } : { name: detail } });
  }
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Supplier not found.");
  return NextResponse.json({ supplier: result.data }, { headers: NO_STORE });
}
