import { NextRequest, NextResponse } from "next/server";

import { fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { describeSettingsFailure, settingsApi } from "@/lib/settings";

export const dynamic = "force-dynamic";

// The latest settings changes of the signed-in administrator's own organization (who, what, when). No organization parameter exists.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await settingsApi.history(token, 25);
  if (!result || result.status !== 200) {
    const f = describeSettingsFailure(result);
    return fail(f.message, f.status, { code: f.code });
  }
  return NextResponse.json(result.data, { headers: NO_STORE });
}
