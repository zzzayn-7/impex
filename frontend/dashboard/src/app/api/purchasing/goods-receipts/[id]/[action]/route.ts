import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

const ACTIONS = ["confirm", "cancel"];

// CONFIRM adds the ACCEPTED quantities to stock (through the Purchasing Service, which asks the Inventory Service with a stable
// key); calling it again is always safe. 200 = confirmed. 202 = the posting could not be verified yet: the receipt stays in
// "posting" and the same call finishes it later - nothing is lost and nothing is added twice. CANCEL discards a draft.
// The browser never talks to the Inventory Service, and no stock quantity is ever read from it.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Goods receipt not found.", 404);
  const result = await purchasingRequest("POST", `/api/v1/purchasing/goods-receipts/${params.id}/${params.action}`, token);
  if (!result || (result.status !== 200 && result.status !== 202)) return purchasingFailureResponse(result, "Goods receipt not found.");
  return NextResponse.json({ receipt: result.data, confirmed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
