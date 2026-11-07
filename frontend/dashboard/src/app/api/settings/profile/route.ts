import { NextRequest, NextResponse } from "next/server";

import { fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { describeSettingsFailure, settingsApi } from "@/lib/settings";
import { checkFullName } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

// SAVE the signed-in administrator's OWN display name. Only `fullName` is read; the Auth Service changes that one field of the person the
// session belongs to (never a role, e-mail, organization or password, and never another administrator). The name in the portal header
// comes from the Auth Service on every request, so it is the new one on the very next page.
export async function PATCH(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const name = checkFullName(body.fullName);
  if (!name.ok) return fail(name.message, 400, { fieldErrors: { fullName: name.message } });
  const result = await settingsApi.saveProfile(token, name.value);
  if (!result || result.status !== 200) {
    const f = describeSettingsFailure(result);
    return fail(f.message, f.status, { code: f.code, ...(f.code === "invalid_name" ? { fieldErrors: { fullName: f.message } } : {}) });
  }
  return NextResponse.json({ user: { full_name: result.data?.full_name } }, { headers: NO_STORE });
}
