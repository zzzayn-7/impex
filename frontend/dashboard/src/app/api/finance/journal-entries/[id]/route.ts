import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, isResponse, NO_STORE, parseEntryBody, readObject, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Journal entry not found.", 404);
  const result = await financeRequest("GET", `/api/v1/finance/journal-entries/${params.id}`, token);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Journal entry not found.");
  return NextResponse.json({ entry: result.data }, { headers: NO_STORE });
}

// Replace a DRAFT. A posted entry can never be edited (the service and its database refuse).
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Journal entry not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseEntryBody(body, true);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("PUT", `/api/v1/finance/journal-entries/${params.id}`, token, parsed.value);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Journal entry not found.");
  return NextResponse.json({ entry: result.data }, { headers: NO_STORE });
}

// Discard a DRAFT. A posted entry can never be deleted: reverse it.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Journal entry not found.", 404);
  const result = await financeRequest("DELETE", `/api/v1/finance/journal-entries/${params.id}`, token);
  if (!result || result.status !== 204) return financeFailureResponse(result, "Journal entry not found.");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
