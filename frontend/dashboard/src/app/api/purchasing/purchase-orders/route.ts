import { NextRequest, NextResponse } from "next/server";

import { CURRENCY_RE, checkDate, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// List / search purchase orders of the signed-in administrator's organization.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status === "draft" || status === "ordered" || status === "partially_received" || status === "received" || status === "cancelled") params.set("status", status);
  const supplierId = p.get("supplierId");
  if (supplierId) {
    if (!checkUuid(supplierId)) return fail("Supplier not found.", 404);
    params.set("supplier_id", supplierId);
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await purchasingRequest("GET", `/api/v1/purchasing/purchase-orders?${params}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// CREATE a draft purchase order.
//
// The browser sends an Idempotency-Key with every create (generated once per form), so a double click or a retry after a
// timeout returns the same order instead of creating a second one. Only the supplier, currency, dates, reference and notes are
// read from the browser; the number, status, owner and totals are decided by the Purchasing Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const supplierId = checkUuid(body.supplierId);
  const currency = (text(body.currencyCode) ?? "").toUpperCase();
  const reference = collapse(text(body.supplierReference) ?? "");
  const notes = text(body.notes) ?? "";
  const orderDate = text(body.orderDate) ?? "";
  const expected = text(body.expectedDeliveryDate) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (!supplierId) fieldErrors.supplierId = "Choose a supplier.";
  if (!CURRENCY_RE.test(currency)) fieldErrors.currencyCode = "Use a 3-letter currency code such as USD or EUR.";
  if (reference.length > 100) fieldErrors.supplierReference = "Use 100 characters or fewer.";
  if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  if (orderDate && !checkDate(orderDate)) fieldErrors.orderDate = "Enter a valid date.";
  if (expected && !checkDate(expected)) fieldErrors.expectedDeliveryDate = "Enter a valid date.";
  if (orderDate && expected && !fieldErrors.orderDate && !fieldErrors.expectedDeliveryDate && expected < orderDate) {
    fieldErrors.expectedDeliveryDate = "The expected delivery cannot be before the order date.";
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await purchasingRequest(
    "POST", "/api/v1/purchasing/purchase-orders", token,
    {
      supplier_id: supplierId, currency_code: currency, supplier_reference: reference, notes,
      ...(orderDate ? { order_date: orderDate } : {}), ...(expected ? { expected_delivery_date: expected } : {}),
    },
    { "Idempotency-Key": key }
  );
  if (!result || (result.status !== 201 && result.status !== 200)) return purchasingFailureResponse(result, "Supplier not found.");
  // 201 = created now, 200 = this exact request had already been processed (a retry): the browser treats both as success.
  return NextResponse.json({ order: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
