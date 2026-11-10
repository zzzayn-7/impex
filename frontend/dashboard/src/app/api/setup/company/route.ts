import { NextRequest, NextResponse } from "next/server";

import { describeSetupFailure, org } from "@/lib/onboarding";
import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { checkCurrency } from "@/lib/currencies";
import { isKnownTimezone } from "@/lib/timezones";
import { checkCompanyName } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

// SAVE the company name (and the chosen default currency, when it is sent) while setting up, so a refresh or a later visit resumes with it. Only
// `companyName` and `defaultCurrency` are read: the slug, id,
// country and ownership are not accepted anywhere, and the organization comes from the session.
export async function PUT(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const name = checkCompanyName(body.companyName);
  if (!name.ok) return fail(name.message, 400, { fieldErrors: { companyName: name.message } });
  let currency: string | undefined;
  if (body.defaultCurrency !== undefined) {
    const checked = checkCurrency(body.defaultCurrency);
    if (!checked.ok) return fail(checked.message, 400, { fieldErrors: { defaultCurrency: checked.message } });
    currency = checked.value;
  }
  let zone: string | undefined;
  if (body.timezone !== undefined) {
    if (!isKnownTimezone(body.timezone)) return fail("Choose a valid location from the list.", 400, { fieldErrors: { timezone: "Choose a valid location from the list." } });
    zone = body.timezone;
  }
  const result = await org.saveCompany(token, name.value, currency, zone);
  if (!result || result.status !== 200) {
    const f = describeSetupFailure(result);
    return fail(f.message, f.status, { code: f.code, ...(f.code === "invalid_company_name" ? { fieldErrors: { companyName: f.message } } : f.code === "invalid_currency" ? { fieldErrors: { defaultCurrency: f.message } } : f.code === "invalid_timezone" ? { fieldErrors: { timezone: f.message } } : {}) });
  }
  return NextResponse.json({ setup: result.data }, { headers: NO_STORE });
}
