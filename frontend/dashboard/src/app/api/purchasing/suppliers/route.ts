import { NextRequest, NextResponse } from "next/server";

import { EMAIL_RE, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

const LIMITS: [string, number][] = [["code", 32], ["contactPerson", 255], ["phone", 50], ["address", 500], ["taxIdentifier", 50]];

// Search / list the signed-in administrator's suppliers (for pickers and the Suppliers page).
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
  const result = await purchasingRequest("GET", `/api/v1/purchasing/suppliers?${params}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// REGISTER a supplier. Only these fields are read from the browser; the organization is decided by the Purchasing Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const name = collapse(text(body.name) ?? "");
  const email = text(body.email) ?? "";
  const country = (text(body.countryCode) ?? "").toUpperCase();
  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter the supplier's name.";
  else if (name.length > 255) fieldErrors.name = "Name must be 255 characters or fewer.";
  if (email && !EMAIL_RE.test(email)) fieldErrors.email = "Enter a valid e-mail address.";
  if (country && !/^[A-Z]{2}$/.test(country)) fieldErrors.countryCode = "Use the 2-letter country code, e.g. DE, PK, US.";
  const code = (text(body.code) ?? "").toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code)) fieldErrors.code = "Letters, digits and . _ - only (max 32).";
  for (const [field, max] of LIMITS) {
    const value = text(body[field]);
    if (value && value.length > max) fieldErrors[field] = `Use ${max} characters or fewer.`;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await purchasingRequest("POST", "/api/v1/purchasing/suppliers", token, {
    name, code, email, country_code: country,
    contact_person: text(body.contactPerson) ?? "", phone: text(body.phone) ?? "", address: text(body.address) ?? "", tax_identifier: text(body.taxIdentifier) ?? "",
  });
  if (result?.status === 409 && typeof result.data?.detail === "string") {
    const detail: string = result.data.detail;
    return fail(detail, 409, { fieldErrors: detail.includes("code") ? { code: detail } : { name: detail } });
  }
  if (!result || result.status !== 201) return purchasingFailureResponse(result);
  return NextResponse.json({ supplier: result.data }, { status: 201, headers: NO_STORE });
}
