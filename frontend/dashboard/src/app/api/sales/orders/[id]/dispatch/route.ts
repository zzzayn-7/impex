import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { shortfall } from "@/lib/sales-browser";

export const dynamic = "force-dynamic";

const NONE = /^0(?:\.0+)?$/;

// DISPATCH an order from the Delivery Lists page in one step: everything that has not been dispatched yet leaves stock together.
//
// This is the same audited workflow as before, driven from one place: a dispatch is prepared for the order's delivery list with every remaining
// quantity, then CONFIRMED. Only the confirmation changes stock (the Sales Service asks the Inventory Service with a stable key, deducts the physical
// stock and consumes the order's reservation); when the last line is confirmed the order becomes Delivered.
//
// Safe to repeat: a dispatch that is already `posting` is only confirmed again (nothing is taken out twice); a draft left behind by an earlier
// refusal (for example not enough stock) is refreshed with the current remaining quantities and confirmed; a first attempt uses a stable
// Idempotency-Key, so a double click cannot create two dispatches. The browser sends nothing but the order id (in the address).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Order not found.", 404);

  const found = await salesRequest("GET", `/api/v1/sales/orders/${params.id}`, token);
  if (!found || found.status !== 200) return salesFailureResponse(found, "Order not found.");
  const order = found.data;
  if (order.status !== "active") return fail("This order cannot be dispatched right now.", 409);

  const dispatches: Array<{ id: string; status: string }> = Array.isArray(order.dispatches) ? order.dispatches : [];
  const posting = dispatches.find((d) => d.status === "posting");
  const draft = dispatches.find((d) => d.status === "draft");

  let dispatchId: string;
  if (posting) {
    dispatchId = posting.id; // already on its way to stock: only finish it
  } else {
    const lines = (Array.isArray(order.lines) ? order.lines : [])
      .map((l: { id: string; ordered_quantity: string; dispatched_quantity: string }) => ({ delivery_list_item_id: l.id, quantity: shortfall(l.ordered_quantity, l.dispatched_quantity) }))
      .filter((l: { quantity: string }) => !NONE.test(l.quantity));
    if (!draft && !order.can_dispatch) return fail(order.message || "This order cannot be dispatched right now.", 409);
    if (lines.length === 0) return fail("Nothing is left to dispatch on this order.", 409);

    if (draft) {
      const saved = await salesRequest("PUT", `/api/v1/sales/dispatches/${draft.id}/lines`, token, { lines });
      if (!saved || saved.status !== 200) return salesFailureResponse(saved, "Dispatch not found.");
      dispatchId = draft.id;
    } else {
      const created = await salesRequest(
        "POST", "/api/v1/sales/dispatches", token,
        { delivery_list_id: order.delivery_list.id, lines },
        { "Idempotency-Key": `order-dispatch-${params.id}-${dispatches.length}` },
      );
      if (!created || (created.status !== 201 && created.status !== 200)) return salesFailureResponse(created, "Delivery list not found.");
      dispatchId = created.data.id;
    }
  }

  const confirmed = await salesRequest("POST", `/api/v1/sales/dispatches/${dispatchId}/confirm`, token);
  if (!confirmed || (confirmed.status !== 200 && confirmed.status !== 202)) return salesFailureResponse(confirmed, "Dispatch not found.");
  return NextResponse.json(
    { dispatch: confirmed.data, confirmed: confirmed.status === 200, dispatchedOn: confirmed.data?.dispatch_date ?? null },
    { status: confirmed.status, headers: NO_STORE },
  );
}
