import { NextRequest, NextResponse } from "next/server";

import { fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { describeSettingsFailure, settingsApi } from "@/lib/settings";
import { checkLogoFile } from "@/lib/setup-validation";

export const dynamic = "force-dynamic";

const refusal = (result: Parameters<typeof describeSettingsFailure>[0]) => {
  const f = describeSettingsFailure(result);
  return fail(f.message, f.status, { code: f.code, ...(f.current ? { current: f.current } : {}) });
};

// REPLACE the company logo. The browser sends one file and the settings version; nothing else is read. The type and size are checked here to
// avoid a pointless upload; the Organization Service decodes the picture and is the real judge (type, size, dimensions, content), with the
// same validation and storage the first-time setup uses. The organization comes from the session, never from the request.
export async function PUT(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) return fail("Invalid request.", 415);
  const incoming = await req.formData().catch(() => null);
  const file = incoming?.get("file");
  const version = Number(incoming?.get("expected_version"));
  if (!file || typeof file === "string") return fail("Choose an image to upload.", 400);
  if (!Number.isInteger(version) || version < 1) return fail("Reload the page and try again.", 400);
  const problem = checkLogoFile(file);
  if (problem) return fail(problem, 400, { code: "invalid_logo" });
  const form = new FormData();
  form.set("file", file, "logo");
  form.set("expected_version", String(version));
  const result = await settingsApi.putLogo(token, form);
  if (!result || result.status !== 200) return refusal(result);
  return NextResponse.json({ settings: result.data }, { headers: NO_STORE });
}

// REMOVE the logo: the portal falls back to the company monogram.
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const version = Number(req.nextUrl.searchParams.get("expected_version"));
  if (!Number.isInteger(version) || version < 1) return fail("Reload the page and try again.", 400);
  const result = await settingsApi.deleteLogo(token, version);
  if (!result || result.status !== 200) return refusal(result);
  return NextResponse.json({ settings: result.data }, { headers: NO_STORE });
}
