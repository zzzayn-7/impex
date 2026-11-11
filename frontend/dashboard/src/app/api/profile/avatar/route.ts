import { NextRequest, NextResponse } from "next/server";

import { fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { authServiceUrl } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR = () => `${authServiceUrl()}/api/v1/auth/me/avatar`;

// The signed-in administrator's OWN profile picture. There is no id, path or query that names a person: the Auth Service derives who from the session token, so another
// person's picture can never be requested, replaced or removed. Only the validated PNG the service stored is passed on, as a plain image (`nosniff`, a CSP that forbids
// everything). `?v=` is only a cache-buster and is ignored.
async function upstream(token: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(AVATAR(), { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
}

async function reason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const message = body?.detail?.message;
  return typeof message === "string" ? message : "The picture could not be saved. Please try again.";
}

export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const res = await upstream(token, { method: "GET" });
  if (!res) return fail("The picture is temporarily unavailable.", 503);
  if (res.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (res.status === 404) return fail("No profile picture.", 404);
  if (!res.ok) return fail("The picture is temporarily unavailable.", 503);
  return new NextResponse(await res.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "private, max-age=300" },
  });
}

// ADD or REPLACE the picture: one file, nothing else is read. The type and size are checked here to avoid a pointless upload; the Auth Service decodes the picture and is
// the real judge (type, size, dimensions, content) and stores a fresh square PNG.
export async function PUT(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) return fail("Invalid request.", 415);
  const incoming = await req.formData().catch(() => null);
  const file = incoming?.get("file");
  if (!file || typeof file === "string") return fail("Choose a picture to upload.", 400);
  if (!TYPES.includes(file.type)) return fail("Use a PNG, JPEG or WebP picture.", 400);
  if (file.size > MAX_BYTES) return fail("The picture must be 2 MB or smaller.", 400);
  const form = new FormData();
  form.set("file", file, "profile-picture");
  const res = await upstream(token, { method: "PUT", body: form });
  if (!res) return fail("The picture could not be saved just now. Please try again shortly.", 503);
  if (res.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (res.status === 413 || res.status === 415 || res.status === 422) return fail(await reason(res), 400);
  if (!res.ok) return fail("The picture could not be saved. Please try again.", 502);
  const profile = await res.json().catch(() => ({}));
  return NextResponse.json({ has_avatar: Boolean(profile?.has_avatar), avatar_version: profile?.avatar_version ?? null }, { headers: NO_STORE });
}

// REMOVE the picture: the initials are shown again.
export async function DELETE(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const res = await upstream(token, { method: "DELETE" });
  if (!res) return fail("The picture could not be removed just now. Please try again shortly.", 503);
  if (res.status === 401) return fail("Your session has expired. Please sign in again.", 401);
  if (!res.ok) return fail("The picture could not be removed. Please try again.", 502);
  return NextResponse.json({ has_avatar: false, avatar_version: null }, { headers: NO_STORE });
}
