import { NextRequest, NextResponse } from "next/server";

import { checkPrice, checkQuantity, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

// ADD an existing product to a DRAFT order with the ordered quantity and the unit purchase price.
//
// Only the product id, the quantity and the price (exact strings, never numbers) and an optional note
// are read from the browser. The product's name, SKU and unit are fetched by the Purchasing Service from the Inventory
// Service, and the line total is calculated there; anything else in the request is dropped here. If the product is already on
// the order the answer is 409 "duplicate_line" with the existing line.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Purchase order not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const productId = checkUuid(body.productId);
  if (!productId) return fail("Choose a product.", 400, { fieldErrors: { productId: "Choose a product." } });
  const quantity = checkQuantity(body.quantity);
  if (!quantity.ok) return fail(quantity.message, 400, { fieldErrors: { quantity: quantity.message } });
  const price = checkPrice(body.unitPrice);
  if (!price.ok) return fail(price.message, 400, { fieldErrors: { unitPrice: price.message } });
  const notes = text(body.notes) ?? "";
  if (notes.length > 500) return fail("Use 500 characters or fewer.", 400, { fieldErrors: { notes: "Use 500 characters or fewer." } });

  const result = await purchasingRequest("POST", `/api/v1/purchasing/purchase-orders/${params.id}/lines`, token, {
    product_id: productId,
    quantity: quantity.value,
    unit_price: price.value,
    ...(notes ? { notes } : {}),
  });
  if (!result || result.status !== 201) return purchasingFailureResponse(result, "Purchase order not found.");
  return NextResponse.json(result.data, { status: 201, headers: NO_STORE });
}
