import { NextRequest, NextResponse } from "next/server";

import { checkDate, checkUuid, collapse, fail, isResponse, NO_STORE, parseReceiptLines, readObject, sessionToken, text } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "posting", "confirmed", "cancelled"];

// List / search the goods receipts of the signed-in administrator's organization.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status && STATUSES.includes(status)) params.set("status", status);
  for (const [name, upstream] of [["purchaseOrderId", "purchase_order_id"], ["supplierId", "supplier_id"], ["productId", "product_id"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkUuid(value)) return fail("Not found.", 404);
      params.set(upstream, value);
    }
  }
  for (const [name, upstream] of [["dateFrom", "date_from"], ["dateTo", "date_to"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkDate(value)) return fail("Enter a valid date.", 400);
      params.set(upstream, value);
    }
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await purchasingRequest("GET", `/api/v1/purchasing/goods-receipts?${params}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// START a DRAFT goods receipt against a purchase order (optionally with its lines). A draft changes NO stock.
//
// The browser sends an Idempotency-Key with every create (generated once per page), so a double click or a retry returns the same
// draft instead of a second one. Only the order id, the date, the supplier's reference, a note and the lines (order-line id,
// accepted / rejected quantity as exact strings, note) are read from the browser. Product, SKU, name and unit come from
// the order; the number, status, owner and organization are decided by the Purchasing Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const orderId = checkUuid(body.purchaseOrderId);
  if (!orderId) return fail("Purchase order not found.", 404);
  const receivedDate = text(body.receivedDate) ?? "";
  const reference = collapse(text(body.supplierReference) ?? "");
  const notes = text(body.notes) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (receivedDate && !checkDate(receivedDate)) fieldErrors.receivedDate = "Enter a valid date.";
  if (reference.length > 100) fieldErrors.supplierReference = "Use 100 characters or fewer.";
  if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  const lines = parseReceiptLines(body.lines ?? []);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});

  const result = await purchasingRequest(
    "POST", "/api/v1/purchasing/goods-receipts", token,
    {
      purchase_order_id: orderId, supplier_reference: reference, notes, lines: lines.lines,
      ...(receivedDate ? { received_date: receivedDate } : {}),
    },
    { "Idempotency-Key": key }
  );
  if (!result || (result.status !== 201 && result.status !== 200)) return purchasingFailureResponse(result, "Purchase order not found.");
  // 201 = created now, 200 = this exact request had already been processed (a retry): the browser treats both as success.
  return NextResponse.json({ receipt: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
