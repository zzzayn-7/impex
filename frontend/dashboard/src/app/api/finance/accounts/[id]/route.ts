import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { ACCOUNT_CODE_RE, ACCOUNT_TYPES, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Change an account. Only the name, description, code, type and active flag are read. A system account (one Finance posts to) and an account
// that already has postings keep their code and type: the Finance Service and its database refuse those changes.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Account not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  if (body.code !== undefined) {
    const code = (text(body.code) ?? "").toUpperCase();
    if (!ACCOUNT_CODE_RE.test(code)) fieldErrors.code = "Use up to 20 letters, digits, dots, dashes or underscores.";
    else changes.code = code;
  }
  if (body.name !== undefined) {
    const name = collapse(text(body.name) ?? "");
    if (!name || name.length > 150) fieldErrors.name = "Enter a name of 150 characters or fewer.";
    else changes.name = name;
  }
  if (body.description !== undefined) {
    const description = collapse(text(body.description) ?? "");
    if (description.length > 500) fieldErrors.description = "Use 500 characters or fewer.";
    else changes.description = description;
  }
  if (body.accountType !== undefined) {
    if (!(ACCOUNT_TYPES as readonly string[]).includes(String(body.accountType))) fieldErrors.accountType = "Choose a type.";
    else changes.account_type = body.accountType;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") fieldErrors.isActive = "Invalid value.";
    else changes.is_active = body.isActive;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  if (Object.keys(changes).length === 0) return fail("Nothing to change.", 400);
  const result = await financeRequest("PATCH", `/api/v1/finance/accounts/${params.id}`, token, changes);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Account not found.");
  return NextResponse.json({ account: result.data }, { headers: NO_STORE });
}

// Delete an account that has never been used. A system account, or one with postings or expenses, is refused (deactivate it instead).
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Account not found.", 404);
  const result = await financeRequest("DELETE", `/api/v1/finance/accounts/${params.id}`, token);
  if (!result || result.status !== 204) return financeFailureResponse(result, "Account not found.");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
