import { NextRequest, NextResponse } from "next/server";

import { checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// One delivery list with its items and the CURRENT stock of each product (information only: stock is not reserved).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Delivery list not found.", 404);
  const result = await salesRequest("GET", `/api/v1/sales/delivery-lists/${params.id}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Delivery list not found.");
  return NextResponse.json({ list: result.data }, { headers: NO_STORE });
}

// EDIT the reference and notes of a draft list. Status changes have their own routes; there is no delete.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Delivery list not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, string> = {};
  const fieldErrors: Record<string, string> = {};
  const reference = text(body.externalReference);
  const notes = text(body.notes);
  if (reference !== undefined) {
    change.external_reference = collapse(reference);
    if (change.external_reference.length > 100) fieldErrors.externalReference = "Use 100 characters or fewer.";
  }
  if (notes !== undefined) {
    change.notes = notes;
    if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  }
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await salesRequest("PATCH", `/api/v1/sales/delivery-lists/${params.id}`, token, change);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Delivery list not found.");
  return NextResponse.json({ list: result.data }, { headers: NO_STORE });
}
