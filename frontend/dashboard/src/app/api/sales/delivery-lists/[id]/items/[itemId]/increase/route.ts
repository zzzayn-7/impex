import { NextRequest, NextResponse } from "next/server";

import { checkQuantity, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// INCREASE an existing line by an explicit amount. Used only when the user chooses it after being told the product is
// already on the list; scanning a product again never reaches this route by itself.
export async function POST(req: NextRequest, { params }: { params: { id: string; itemId: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id) || !checkUuid(params.itemId)) return fail("Item not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const quantity = checkQuantity(body.quantity);
  if (!quantity.ok) return fail(quantity.message, 400, { fieldErrors: { quantity: quantity.message } });

  const result = await salesRequest("POST", `/api/v1/sales/delivery-lists/${params.id}/items/${params.itemId}/increase`, token, { quantity: quantity.value });
  if (!result || result.status !== 200) return salesFailureResponse(result, "Item not found.");
  return NextResponse.json(result.data, { headers: NO_STORE });
}
