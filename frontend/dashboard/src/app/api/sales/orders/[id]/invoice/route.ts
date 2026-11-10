import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// GENERATE INVOICE from a dispatched order (the Delivery Lists card's one button after a dispatch). The browser sends nothing but the order id (in the
// address): the Sales Service builds a DRAFT invoice for the order's client from the goods that were dispatched, priced with the products' current
// selling price, and saves it. It never changes stock, and repeating it returns the invoice the order already has (200) instead of a second one (201 =
// made now). Whose order it is comes from the session; another organization's order answers "not found".
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Order not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/orders/${params.id}/invoice`, token);
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Order not found.");
  const invoice = result.data?.invoice ?? {};
  return NextResponse.json(
    { invoice: { id: invoice.id, number: invoice.number ?? null, status: invoice.status, total: invoice.total, currency_code: invoice.currency_code }, created: result.data?.created === true },
    { status: result.status, headers: NO_STORE },
  );
}
