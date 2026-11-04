import { NextRequest, NextResponse } from "next/server";

import { checkDate, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Goods receipt not found.", 404);
  const result = await purchasingRequest("GET", `/api/v1/purchasing/goods-receipts/${params.id}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Goods receipt not found.");
  return NextResponse.json({ receipt: result.data }, { headers: NO_STORE });
}

// Edit the date, the supplier's reference or the notes of a DRAFT receipt (a receipt that is posting or confirmed is refused upstream).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Goods receipt not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  if (body.receivedDate !== undefined) {
    const date = text(body.receivedDate) ?? "";
    if (!checkDate(date)) fieldErrors.receivedDate = "Enter a valid date.";
    else changes.received_date = date;
  }
  if (body.supplierReference !== undefined) {
    const reference = collapse(text(body.supplierReference) ?? "");
    if (reference.length > 100) fieldErrors.supplierReference = "Use 100 characters or fewer.";
    else changes.supplier_reference = reference;
  }
  if (body.notes !== undefined) {
    const notes = text(body.notes) ?? "";
    if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
    else changes.notes = notes;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  if (Object.keys(changes).length === 0) return fail("Nothing to change.", 400);
  const result = await purchasingRequest("PATCH", `/api/v1/purchasing/goods-receipts/${params.id}`, token, changes);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Goods receipt not found.");
  return NextResponse.json({ receipt: result.data }, { headers: NO_STORE });
}
