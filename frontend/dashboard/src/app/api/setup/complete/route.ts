import { NextRequest, NextResponse } from "next/server";

import { checkCurrency } from "@/lib/currencies";
import { isKnownTimezone } from "@/lib/timezones";
import { auth, describeSetupFailure, org } from "@/lib/onboarding";
import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { checkCompanyName, checkFullName } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

// COMPLETE first-time setup. Two services own two records, and they are not one database transaction, so this is a small saga that
// is safe to repeat from any point:
//   1. company (Organization Service) - if it is not completed yet: confirm the name and finish (it also verifies the logo is really
//      stored). Skipped when the company is already completed (a second administrator, or a retry).
//   2. profile (Auth Service) - confirm the administrator's name and mark their profile done, in one transaction.
// If step 2 fails after step 1 succeeded, the company stays completed and the administrator simply lands on the short "about you"
// screen next time (or retries this call): nothing is lost and nothing is applied twice. Setup counts as done only when BOTH
// records say so; the browser is sent to the dashboard only on that answer. The organization and the user come from the session.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const fullName = checkFullName(body.fullName);
  if (!fullName.ok) return fail(fullName.message, 400, { fieldErrors: { fullName: fullName.message } });

  const status = await org.status(token);
  if (!status || status.status !== 200) {
    const f = describeSetupFailure(status);
    return fail(f.message, f.status, { code: f.code });
  }
  const companyAlreadyDone = status.data?.setup_status === "completed";
  if (!companyAlreadyDone) {
    const company = checkCompanyName(body.companyName);
    if (!company.ok) return fail(company.message, 400, { fieldErrors: { companyName: company.message } });
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
    const done = await org.complete(token, company.value, currency, zone);
    if (!done || done.status !== 200) {
      const f = describeSetupFailure(done);
      return fail(f.message, f.status, { code: f.code, ...(f.code === "invalid_company_name" ? { fieldErrors: { companyName: f.message } } : f.code === "invalid_currency" ? { fieldErrors: { defaultCurrency: f.message } } : {}) });
    }
  }

  const profile = await auth.completeProfile(token, fullName.value);
  if (!profile || profile.status !== 200) {
    const f = describeSetupFailure(profile, "profile");
    const message = companyAlreadyDone ? f.message : `Your company was set up, but your profile could not be saved yet. ${f.message}`;
    return fail(message, f.status, { code: f.code, companySetupDone: true, ...(f.code === "invalid_name" ? { fieldErrors: { fullName: f.message } } : {}) });
  }
  return NextResponse.json({ done: true, redirectTo: "/" }, { headers: NO_STORE });
}
