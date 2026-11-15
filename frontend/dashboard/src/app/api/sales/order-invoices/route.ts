import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// CREATE the invoice of one PREPARED order (Sales Invoice > New invoice > Create invoice). The browser sends only the order id: the Sales Service builds the invoice from the
// order's own lines at the prices agreed on it, and repeating the request returns the invoice the order already has (200) instead of making a second one (201 when made now).
// Whose order it is comes from the session; another organization's order answers "not found".
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  if (!checkUuid(orderId)) return fail("Order not found.", 404);
  const result = await salesRequest("POST", "/api/v1/sales/order-invoices", token, { order_id: orderId });
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Order not found.");
  const invoice = result.data ?? {};
  return NextResponse.json({ invoice: { id: invoice.id, number: invoice.number }, created: result.status === 201 }, { status: result.status, headers: NO_STORE });
}
