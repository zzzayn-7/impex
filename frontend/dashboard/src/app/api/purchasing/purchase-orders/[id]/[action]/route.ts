import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

const ACTIONS = ["order", "cancel"];

// Place the order with the supplier ("order": its details and lines are frozen) or cancel it (kept for history). NEITHER
// touches inventory: no stock is added and no stock movement is written. Goods are received through /api/purchasing/goods-receipts.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Purchase order not found.", 404);
  const result = await purchasingRequest("POST", `/api/v1/purchasing/purchase-orders/${params.id}/${params.action}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Purchase order not found.");
  return NextResponse.json({ order: result.data }, { headers: NO_STORE });
}
