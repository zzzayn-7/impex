import { NextRequest, NextResponse } from "next/server";

import { checkQuantity, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// ADD a product to a draft list with an EXPLICIT quantity.
//
// Only the product id, the quantity (an exact string, never a number) and an optional planned warehouse are read from the
// browser. The product's name, SKU, unit and stock are fetched by the Sales Service from the Inventory Service; anything
// else in the request is dropped here. If the product is already on the list the answer is 409 "duplicate_item" with the
// existing line, so the user can choose to edit or increase it: nothing is incremented implicitly.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Delivery list not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const productId = checkUuid(body.productId);
  if (!productId) return fail("Choose a product.", 400, { fieldErrors: { productId: "Choose a product." } });
  const quantity = checkQuantity(body.quantity);
  if (!quantity.ok) return fail(quantity.message, 400, { fieldErrors: { quantity: quantity.message } });
  let warehouseId: string | undefined;
  if (body.plannedWarehouseId !== undefined && body.plannedWarehouseId !== null && body.plannedWarehouseId !== "") {
    const valid = checkUuid(body.plannedWarehouseId);
    if (!valid) return fail("Choose a valid warehouse.", 400, { fieldErrors: { plannedWarehouseId: "Choose a valid warehouse." } });
    warehouseId = valid;
  }

  const result = await salesRequest("POST", `/api/v1/sales/delivery-lists/${params.id}/items`, token, {
    product_id: productId,
    quantity: quantity.value,
    ...(warehouseId ? { planned_warehouse_id: warehouseId } : {}),
  });
  if (!result || result.status !== 201) return salesFailureResponse(result, "Delivery list not found.");
  return NextResponse.json(result.data, { status: 201, headers: NO_STORE });
}
