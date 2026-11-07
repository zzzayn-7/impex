import { NextRequest, NextResponse } from "next/server";

import { DATE_FORMAT_OPTIONS, NUMBER_FORMAT_OPTIONS } from "@/lib/format";
import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { describeSettingsFailure, settingsApi } from "@/lib/settings";

export const dynamic = "force-dynamic";

const FIELDS = ["default_currency", "timezone", "date_format", "number_format"] as const;

// SAVE business preferences. They are DEFAULTS and DISPLAY settings: saving them converts or rewrites nothing that was already recorded.
// Only these four fields and the settings version are read; the Organization Service validates them against the ISO 4217 and IANA lists.
export async function PATCH(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  if (typeof body.expected_version !== "number" || !Number.isInteger(body.expected_version) || body.expected_version < 1) return fail("Reload the page and try again.", 400);
  const payload: Record<string, unknown> = { expected_version: body.expected_version };
  const errors: Record<string, string> = {};
  for (const field of FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) errors[field] = "Choose a value.";
    else if (field === "default_currency" && !/^[A-Za-z]{3}$/.test(value.trim())) errors[field] = "Use a 3-letter currency code such as PKR, USD or EUR.";
    else if (field === "date_format" && !DATE_FORMAT_OPTIONS.some((o) => o.value === value)) errors[field] = "Choose one of the available date formats.";
    else if (field === "number_format" && !NUMBER_FORMAT_OPTIONS.some((o) => o.value === value)) errors[field] = "Choose one of the available number formats.";
    else payload[field] = field === "default_currency" ? value.trim().toUpperCase() : value.trim();
  }
  if (Object.keys(errors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors: errors });
  if (Object.keys(payload).length === 1) return fail("There is nothing to save.", 400);
  const result = await settingsApi.patchPreferences(token, payload);
  if (!result || result.status !== 200) {
    const f = describeSettingsFailure(result);
    return fail(f.message, f.status, { code: f.code, ...(f.field ? { fieldErrors: { [f.field]: f.message } } : {}), ...(f.current ? { current: f.current } : {}) });
  }
  return NextResponse.json({ settings: result.data }, { headers: NO_STORE });
}
