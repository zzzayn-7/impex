import { NextRequest, NextResponse } from "next/server";

import { CURRENCY_RE, checkDate, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

// One purchase order with its lines and the total calculated by the Purchasing Service.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Purchase order not found.", 404);
  const result = await purchasingRequest("GET", `/api/v1/purchasing/purchase-orders/${params.id}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Purchase order not found.");
  return NextResponse.json({ order: result.data }, { headers: NO_STORE });
}

// EDIT the header of a DRAFT order (the Purchasing Service refuses it once the order is placed). Status changes have their
// own routes; DELETE is below.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Purchase order not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  if (body.supplierId !== undefined) {
    const id = checkUuid(body.supplierId);
    if (id) change.supplier_id = id;
    else fieldErrors.supplierId = "Choose a supplier.";
  }
  if (body.currencyCode !== undefined) {
    const currency = (text(body.currencyCode) ?? "").toUpperCase();
    if (CURRENCY_RE.test(currency)) change.currency_code = currency;
    else fieldErrors.currencyCode = "Use a 3-letter currency code such as USD or EUR.";
  }
  for (const [field, apiName] of [["orderDate", "order_date"], ["expectedDeliveryDate", "expected_delivery_date"]] as const) {
    if (body[field] === undefined) continue;
    const value = text(body[field]) ?? "";
    if (!value) {
      if (field === "orderDate") fieldErrors[field] = "Enter the order date.";
      else change[apiName] = null; // clearing the expected delivery date
    } else if (!checkDate(value)) fieldErrors[field] = "Enter a valid date.";
    else change[apiName] = value;
  }
  if (body.supplierReference !== undefined) {
    const reference = collapse(text(body.supplierReference) ?? "");
    if (reference.length > 100) fieldErrors.supplierReference = "Use 100 characters or fewer.";
    else change.supplier_reference = reference;
  }
  if (body.notes !== undefined) {
    const notes = text(body.notes) ?? "";
    if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
    else change.notes = notes;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);

  const result = await purchasingRequest("PATCH", `/api/v1/purchasing/purchase-orders/${params.id}`, token, change);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Purchase order not found.");
  return NextResponse.json({ order: result.data }, { headers: NO_STORE });
}

// DELETE an order for good: a draft, placed or cancelled order that has no goods receipt. The Purchasing Service decides (it refuses, 409, an order with goods received or any
// receipt) and never touches inventory. Nothing is read from the browser but the order in the address.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Purchase order not found.", 404);
  const result = await purchasingRequest("DELETE", `/api/v1/purchasing/purchase-orders/${params.id}`, token);
  if (!result || result.status !== 204) return purchasingFailureResponse(result, "Purchase order not found.");
  return NextResponse.json({ deleted: true }, { headers: NO_STORE });
}
