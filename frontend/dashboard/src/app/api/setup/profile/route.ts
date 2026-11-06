import { NextRequest, NextResponse } from "next/server";

import { auth, describeSetupFailure } from "@/lib/onboarding";
import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { checkFullName } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

// SAVE the administrator's own full name while setting up. Only `fullName` is read; the Auth Service changes that one field of the
// person the session belongs to (never a role, e-mail, organization or password, and never another user).
export async function PUT(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const name = checkFullName(body.fullName);
  if (!name.ok) return fail(name.message, 400, { fieldErrors: { fullName: name.message } });
  const result = await auth.saveProfile(token, name.value);
  if (!result || result.status !== 200) {
    const f = describeSetupFailure(result, "profile");
    return fail(f.message, f.status, { code: f.code, ...(f.code === "invalid_name" ? { fieldErrors: { fullName: f.message } } : {}) });
  }
  return NextResponse.json({ user: { full_name: result.data?.full_name } }, { headers: NO_STORE });
}
