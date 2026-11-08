import { NextRequest, NextResponse } from "next/server";

import { checkQuantity, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string; itemId: string } };

// SET the quantity of a line of a draft list.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id) || !checkUuid(params.itemId)) return fail("Item not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, unknown> = {};
  if (body.quantity !== undefined) {
    const quantity = checkQuantity(body.quantity);
    if (!quantity.ok) return fail(quantity.message, 400, { fieldErrors: { quantity: quantity.message } });
    change.quantity = quantity.value;
  }
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);

  const result = await salesRequest("PATCH", `/api/v1/sales/delivery-lists/${params.id}/items/${params.itemId}`, token, change);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Item not found.");
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// REMOVE a line from a draft list (it only ever was a note; no stock is involved).
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id) || !checkUuid(params.itemId)) return fail("Item not found.", 404);
  const result = await salesRequest("DELETE", `/api/v1/sales/delivery-lists/${params.id}/items/${params.itemId}`, token);
  if (!result || result.status !== 204) return salesFailureResponse(result, "Item not found.");
  return NextResponse.json({ removed: true }, { headers: NO_STORE });
}
