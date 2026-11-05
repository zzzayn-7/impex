import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const ACTIONS = ["confirm", "cancel"];

// CONFIRM deducts the dispatched quantities from stock (through the Sales Service, which asks the Inventory Service with a stable
// key); calling it again is always safe. 200 = confirmed. 202 = the posting could not be verified yet: the dispatch stays in
// "posting" and the same call finishes it later - nothing is lost and nothing is deducted twice. CANCEL discards a draft.
// The browser never talks to the Inventory Service, and no stock quantity is ever written from here.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Dispatch not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/dispatches/${params.id}/${params.action}`, token);
  if (!result || (result.status !== 200 && result.status !== 202)) return salesFailureResponse(result, "Dispatch not found.");
  return NextResponse.json({ dispatch: result.data, confirmed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
