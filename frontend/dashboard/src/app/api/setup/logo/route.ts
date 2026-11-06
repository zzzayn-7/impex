import { NextRequest, NextResponse } from "next/server";

import { describeSetupFailure, org } from "@/lib/onboarding";
import { fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { checkLogoFile } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

const answer = (data: unknown) => NextResponse.json({ setup: data }, { headers: NO_STORE });

// UPLOAD or replace the company logo during first-time setup. The browser sends one file; nothing else is read. The type and size are
// checked here to avoid a pointless upload; the Organization Service decodes the picture and is the real judge (type, size,
// dimensions, content). The organization comes from the session, never from the request.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) return fail("Invalid request.", 415);
  const incoming = await req.formData().catch(() => null);
  const file = incoming?.get("file");
  if (!file || typeof file === "string") return fail("Choose an image to upload.", 400);
  const problem = checkLogoFile(file);
  if (problem) return fail(problem, 400, { code: "invalid_logo" });
  const form = new FormData();
  form.set("file", file, "logo");
  const result = await org.uploadLogo(token, form);
  if (!result || result.status !== 200) {
    const f = describeSetupFailure(result, "logo");
    return fail(f.message, f.status, { code: f.code });
  }
  return answer(result.data);
}

// REMOVE the logo (only possible before setup is completed).
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await org.removeLogo(token);
  if (!result || result.status !== 200) {
    const f = describeSetupFailure(result, "logo");
    return fail(f.message, f.status, { code: f.code });
  }
  return answer(result.data);
}
