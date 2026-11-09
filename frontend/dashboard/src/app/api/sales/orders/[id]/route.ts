import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, parseOrderLines, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// One order with its lines and the LIVE physical, reserved and available stock of each product.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Order not found.", 404);
  const result = await salesRequest("GET", `/api/v1/sales/orders/${params.id}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Order not found.");
  return NextResponse.json({ order: result.data }, { headers: NO_STORE });
}

// EDIT an active order: the complete list of products and quantities it should have afterwards, and the version the editor saw. The Sales
// Service adjusts the reservation by the difference (all or nothing) and refuses anything unsafe: a stale version, a quantity below what was
// dispatched, a change while a dispatch is being posted, more than is available.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Order not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const version = typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 1 ? body.version : null;
  if (version === null) return fail("Reload the order and try again.", 400);
  const lines = parseOrderLines(body.lines);
  if (!lines.ok) return fail(lines.message, 400);
  const notes = text(body.notes);
  if (notes !== undefined && notes.length > 2000) return fail("Use 2000 characters or fewer for the notes.", 400);

  const result = await salesRequest("PATCH", `/api/v1/sales/orders/${params.id}`, token, { version, lines: lines.lines, ...(notes !== undefined ? { notes } : {}) });
  if (!result || ![200, 202].includes(result.status)) return salesFailureResponse(result, "Order not found.");
  return NextResponse.json({ order: result.data, pending: result.status === 202 }, { status: result.status, headers: NO_STORE });
}
