import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// Book an OLDER delivery list (made before stock reservations existed): all its quantities are reserved atomically and it becomes a sales
// order. Marking a draft list Ready does the same thing. Physical stock is not touched.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Delivery list not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/delivery-lists/${params.id}/book`, token);
  if (!result || ![200, 202].includes(result.status)) return salesFailureResponse(result, "Delivery list not found.");
  return NextResponse.json({ order: result.data, pending: result.status === 202 }, { status: result.status, headers: NO_STORE });
}
