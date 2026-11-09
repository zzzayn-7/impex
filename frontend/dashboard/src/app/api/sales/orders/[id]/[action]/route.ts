import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const ACTIONS = ["cancel", "cancel-remaining", "reconcile"];

// Cancel an order nothing was dispatched from (its reservation is released), cancel the remaining quantity of a partly delivered order, or
// finish a booking that was left half way. Nothing is deleted. The Sales Service decides whether the action is allowed and explains why not.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Order not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/orders/${params.id}/${params.action}`, token);
  if (!result || ![200, 202].includes(result.status)) return salesFailureResponse(result, "Order not found.");
  return NextResponse.json({ order: result.data, pending: result.status === 202 }, { status: result.status, headers: NO_STORE });
}
