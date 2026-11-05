import { NextRequest, NextResponse } from "next/server";

import { checkDispatchDate, checkUuid, collapse, fail, isResponse, NO_STORE, parseDispatchLines, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "posting", "confirmed", "cancelled"];

// List / search the dispatches of the signed-in administrator's organization.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status && STATUSES.includes(status)) params.set("status", status);
  for (const [name, upstream] of [["deliveryListId", "delivery_list_id"], ["clientId", "client_id"], ["warehouseId", "warehouse_id"], ["productId", "product_id"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkUuid(value)) return fail("Not found.", 404);
      params.set(upstream, value);
    }
  }
  for (const [name, upstream] of [["dateFrom", "date_from"], ["dateTo", "date_to"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkDispatchDate(value)) return fail("Enter a valid date.", 400);
      params.set(upstream, value);
    }
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await salesRequest("GET", `/api/v1/sales/dispatches?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// START a DRAFT dispatch against a Ready / Partially Dispatched delivery list (optionally with its lines). A draft changes NO stock.
//
// The browser sends an Idempotency-Key with every create (generated once per form), so a double click or a retry returns the same
// draft instead of a second one. Only the list id, the date, the address / transport / tracking details, a note and the lines
// (item id, warehouse id, exact quantity string) are read from the browser. Product, SKU, name and unit come from the delivery
// list; the number, status, owner, client and organization are decided by the Sales Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const listId = checkUuid(body.deliveryListId);
  if (!listId) return fail("Delivery list not found.", 404);
  const dispatchDate = text(body.dispatchDate) ?? "";
  const address = text(body.deliveryAddress) ?? "";
  const transport = collapse(text(body.transportDetails) ?? "");
  const tracking = collapse(text(body.trackingReference) ?? "");
  const notes = text(body.notes) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (dispatchDate && !checkDispatchDate(dispatchDate)) fieldErrors.dispatchDate = "Enter a valid date.";
  if (address.length > 1000) fieldErrors.deliveryAddress = "Use 1000 characters or fewer.";
  if (transport.length > 500) fieldErrors.transportDetails = "Use 500 characters or fewer.";
  if (tracking.length > 100) fieldErrors.trackingReference = "Use 100 characters or fewer.";
  if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  const lines = parseDispatchLines(body.lines ?? []);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});

  const result = await salesRequest(
    "POST", "/api/v1/sales/dispatches", token,
    {
      delivery_list_id: listId, delivery_address: address, transport_details: transport, tracking_reference: tracking, notes, lines: lines.lines,
      ...(dispatchDate ? { dispatch_date: dispatchDate } : {}),
    },
    { "Idempotency-Key": key }
  );
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Delivery list not found.");
  // 201 = created now, 200 = this exact request had already been processed (a retry): the browser treats both as success.
  return NextResponse.json({ dispatch: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
