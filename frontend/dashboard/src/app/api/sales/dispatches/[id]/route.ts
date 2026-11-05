import { NextRequest, NextResponse } from "next/server";

import { checkDispatchDate, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Dispatch not found.", 404);
  const result = await salesRequest("GET", `/api/v1/sales/dispatches/${params.id}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Dispatch not found.");
  return NextResponse.json({ dispatch: result.data }, { headers: NO_STORE });
}

// Edit the date, address, transport details, tracking reference or notes of a DRAFT dispatch (one that is posting or confirmed is refused upstream).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Dispatch not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  if (body.dispatchDate !== undefined) {
    const date = text(body.dispatchDate) ?? "";
    if (!checkDispatchDate(date)) fieldErrors.dispatchDate = "Enter a valid date.";
    else changes.dispatch_date = date;
  }
  for (const [name, upstream, max, collapsed] of [["deliveryAddress", "delivery_address", 1000, false], ["transportDetails", "transport_details", 500, true], ["trackingReference", "tracking_reference", 100, true], ["notes", "notes", 2000, false]] as const) {
    if (body[name] === undefined) continue;
    const raw = text(body[name]) ?? "";
    const value = collapsed ? collapse(raw) : raw;
    if (value.length > max) fieldErrors[name] = `Use ${max} characters or fewer.`;
    else changes[upstream] = value;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  if (Object.keys(changes).length === 0) return fail("Nothing to change.", 400);
  const result = await salesRequest("PATCH", `/api/v1/sales/dispatches/${params.id}`, token, changes);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Dispatch not found.");
  return NextResponse.json({ dispatch: result.data }, { headers: NO_STORE });
}
