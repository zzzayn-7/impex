import { NextRequest, NextResponse } from "next/server";

import { checkPrice, checkQuantity, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string; lineId: string } };

// CHANGE the quantity, price, planned warehouse or note of a line of a draft order. The line total is recalculated by the
// Purchasing Service; the browser's own preview is never sent.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id) || !checkUuid(params.lineId)) return fail("Line not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, unknown> = {};
  if (body.quantity !== undefined) {
    const quantity = checkQuantity(body.quantity);
    if (!quantity.ok) return fail(quantity.message, 400, { fieldErrors: { quantity: quantity.message } });
    change.quantity = quantity.value;
  }
  if (body.unitPrice !== undefined) {
    const price = checkPrice(body.unitPrice);
    if (!price.ok) return fail(price.message, 400, { fieldErrors: { unitPrice: price.message } });
    change.unit_price = price.value;
  }
  if (body.plannedWarehouseId !== undefined) {
    if (body.plannedWarehouseId === null || body.plannedWarehouseId === "") change.planned_warehouse_id = null;
    else if (checkUuid(body.plannedWarehouseId)) change.planned_warehouse_id = body.plannedWarehouseId;
    else return fail("Choose a valid warehouse.", 400, { fieldErrors: { plannedWarehouseId: "Choose a valid warehouse." } });
  }
  if (body.notes !== undefined) {
    const notes = text(body.notes) ?? "";
    if (notes.length > 500) return fail("Use 500 characters or fewer.", 400, { fieldErrors: { notes: "Use 500 characters or fewer." } });
    change.notes = notes;
  }
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);

  const result = await purchasingRequest("PATCH", `/api/v1/purchasing/purchase-orders/${params.id}/lines/${params.lineId}`, token, change);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Line not found.");
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// REMOVE a line from a draft order (it only ever was a note; no stock or price was involved).
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id) || !checkUuid(params.lineId)) return fail("Line not found.", 404);
  const result = await purchasingRequest("DELETE", `/api/v1/purchasing/purchase-orders/${params.id}/lines/${params.lineId}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Line not found.");
  return NextResponse.json(result.data, { headers: NO_STORE });
}
