import { NextRequest, NextResponse } from "next/server";

import { fail, isResponse, NO_STORE, readObject, sessionToken, text, collapse } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Search / list the signed-in administrator's clients (for pickers and the Clients page).
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  const status = p.get("status");
  params.set("status", status === "inactive" || status === "all" ? status : "active");
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await salesRequest("GET", `/api/v1/sales/clients?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// REGISTER a client. Only these fields are read from the browser; the organization is decided by the Sales Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const name = collapse(text(body.name) ?? "");
  const email = text(body.email) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter the client's name.";
  else if (name.length > 255) fieldErrors.name = "Name must be 255 characters or fewer.";
  if (email && !EMAIL_RE.test(email)) fieldErrors.email = "Enter a valid e-mail address.";
  const limits: [string, string | undefined, number][] = [["contactPerson", text(body.contactPerson), 255], ["phone", text(body.phone), 50], ["address", text(body.address), 500]];
  for (const [field, value, max] of limits) if (value && value.length > max) fieldErrors[field] = `Use ${max} characters or fewer.`;
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await salesRequest("POST", "/api/v1/sales/clients", token, {
    name,
    contact_person: text(body.contactPerson) ?? "",
    email,
    phone: text(body.phone) ?? "",
    address: text(body.address) ?? "",
  });
  if (result?.status === 409 && typeof result.data?.detail === "string") return fail(result.data.detail, 409, { fieldErrors: { name: result.data.detail } });
  if (!result || result.status !== 201) return salesFailureResponse(result);
  return NextResponse.json({ client: result.data }, { status: 201, headers: NO_STORE });
}
