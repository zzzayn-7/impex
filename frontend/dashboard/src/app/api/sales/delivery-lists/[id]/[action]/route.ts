import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const ACTIONS = ["ready", "cancel", "reopen"];

// Mark a list Ready, Cancelled, or reopen it as a draft. NONE of these touches inventory: stock is neither deducted nor
// reserved. (Dispatch, which will, does not exist yet.)
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Delivery list not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/delivery-lists/${params.id}/${params.action}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Delivery list not found.");
  return NextResponse.json({ list: result.data }, { headers: NO_STORE });
}
