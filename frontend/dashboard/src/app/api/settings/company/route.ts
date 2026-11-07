import { NextRequest, NextResponse } from "next/server";

import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { describeSettingsFailure, settingsApi } from "@/lib/settings";
import { COMPANY_FIELDS, checkCompany, type CompanyField } from "@/lib/settings-validation";

export const dynamic = "force-dynamic";

// SAVE changes to the company profile. Only the editable company fields and the settings version the form was made from are read: the
// organization comes from the session, and an id, slug, country, tax number, status or owner in the request is never forwarded (the
// Organization Service refuses them anyway). Only the fields that are sent change.
export async function PATCH(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  if (typeof body.expected_version !== "number" || !Number.isInteger(body.expected_version) || body.expected_version < 1) return fail("Reload the page and try again.", 400);
  const sent = COMPANY_FIELDS.filter((f) => f in body);
  if (sent.length === 0) return fail("There is nothing to save.", 400);
  // check every sent field with the same rules the forms use (a field that is not sent is left as it is)
  const probe = Object.fromEntries(COMPANY_FIELDS.map((f) => [f, f in body ? body[f] : f === "name" ? "Valid Name" : f === "contact_email" ? "valid@example.com" : ""])) as Record<CompanyField, unknown>;
  const checked = checkCompany(probe);
  if (!checked.ok) {
    const errors = Object.fromEntries(Object.entries(checked.errors).filter(([field]) => field in body));
    if (Object.keys(errors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors: errors });
  }
  const payload: Record<string, unknown> = { expected_version: body.expected_version };
  for (const field of sent) {
    const value = body[field];
    if (value === null && field !== "name" && field !== "contact_email") payload[field] = null;
    else if (checked.ok) payload[field] = checked.value[field];
    else payload[field] = value;
  }
  const result = await settingsApi.patchCompany(token, payload);
  if (!result || result.status !== 200) {
    const f = describeSettingsFailure(result);
    return fail(f.message, f.status, { code: f.code, ...(f.field ? { fieldErrors: { [f.field]: f.message } } : {}), ...(f.current ? { current: f.current } : {}) });
  }
  return NextResponse.json({ settings: result.data }, { headers: NO_STORE });
}
