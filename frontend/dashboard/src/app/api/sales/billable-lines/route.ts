import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// The confirmed dispatch lines of one client that can be invoiced, with what is already invoiced and what is still free. Read-only.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const params = new URLSearchParams();
  const client = req.nextUrl.searchParams.get("clientId") ?? "";
  if (!checkUuid(client)) return fail("Client not found.", 404);
  params.set("client_id", client);
  const list = req.nextUrl.searchParams.get("deliveryListId");
  if (list) {
    if (!checkUuid(list)) return fail("Delivery list not found.", 404);
    params.set("delivery_list_id", list);
  }
  const result = await salesRequest("GET", `/api/v1/sales/billable-lines?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ lines: result.data }, { headers: NO_STORE });
}
