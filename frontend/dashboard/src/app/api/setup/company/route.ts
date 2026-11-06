import { NextRequest, NextResponse } from "next/server";

import { describeSetupFailure, org } from "@/lib/onboarding";
import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { checkCompanyName } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

// SAVE the company name while setting up (so a refresh or a later visit resumes with it). Only `companyName` is read: the slug, id,
// country and ownership are not accepted anywhere, and the organization comes from the session.
export async function PUT(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const name = checkCompanyName(body.companyName);
  if (!name.ok) return fail(name.message, 400, { fieldErrors: { companyName: name.message } });
  const result = await org.saveCompany(token, name.value);
  if (!result || result.status !== 200) {
    const f = describeSetupFailure(result);
    return fail(f.message, f.status, { code: f.code, ...(f.code === "invalid_company_name" ? { fieldErrors: { companyName: f.message } } : {}) });
  }
  return NextResponse.json({ setup: result.data }, { headers: NO_STORE });
}
