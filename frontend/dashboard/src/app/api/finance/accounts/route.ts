import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { ACCOUNT_CODE_RE, ACCOUNT_TYPES, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// The chart of accounts of the signed-in administrator's organization.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const type = p.get("type");
  if (type && (ACCOUNT_TYPES as readonly string[]).includes(type)) params.set("type", type);
  const active = p.get("active");
  if (active === "true" || active === "false") params.set("active", active);
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  const result = await financeRequest("GET", `/api/v1/finance/accounts?${params}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json({ accounts: result.data }, { headers: NO_STORE });
}

// Add an account. Only the code, name, type and description are read: whether it is a system account, who owns it and which organization
// it belongs to are decided by the Finance Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const code = (text(body.code) ?? "").toUpperCase();
  const name = collapse(text(body.name) ?? "");
  const type = text(body.accountType) ?? "";
  const description = collapse(text(body.description) ?? "");
  const fieldErrors: Record<string, string> = {};
  if (!ACCOUNT_CODE_RE.test(code)) fieldErrors.code = "Use up to 20 letters, digits, dots, dashes or underscores.";
  if (!name) fieldErrors.name = "Enter a name.";
  else if (name.length > 150) fieldErrors.name = "Use 150 characters or fewer.";
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) fieldErrors.accountType = "Choose a type.";
  if (description.length > 500) fieldErrors.description = "Use 500 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  const result = await financeRequest("POST", "/api/v1/finance/accounts", token, { code, name, account_type: type, ...(description ? { description } : {}) });
  if (!result || result.status !== 201) return financeFailureResponse(result);
  return NextResponse.json({ account: result.data }, { status: 201, headers: NO_STORE });
}
