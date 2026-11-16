import { NextRequest, NextResponse } from "next/server";

import { parsePlan } from "@/lib/installments";
import { checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// CREATE the invoice of one PREPARED order (Sales Invoice > New invoice > Create invoice). The browser sends the order id and, when the order is paid in installments, how many
// (2 to 5) and how often: the Sales Service builds the invoice from the order's own lines at the prices agreed on it, splits the total and dates the installments, and repeating the
// request returns the invoice the order already has (200) instead of making another (201 when made now). The answer is the FIRST invoice: the one to print now.
// Whose order it is comes from the session; another organization's order answers "not found".
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  if (!checkUuid(orderId)) return fail("Order not found.", 404);
  const forward: Record<string, unknown> = { order_id: orderId };
  if (body.installments !== undefined && body.installments !== null) {
    const plan = parsePlan(body.installments);
    if (!plan) return fail("Choose 2 to 5 installments and the time between payments.", 400);
    forward.installments = plan;
  }
  const result = await salesRequest("POST", "/api/v1/sales/order-invoices", token, forward);
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Order not found.");
  const invoice = result.data ?? {};
  return NextResponse.json({ invoice: { id: invoice.id, number: invoice.number }, created: result.status === 201 }, { status: result.status, headers: NO_STORE });
}
