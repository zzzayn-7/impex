import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// ACTIVATE / DEACTIVATE a client (soft state change; nothing is deleted).
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (params.action !== "activate" && params.action !== "deactivate") return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Client not found.", 404);
  const result = await salesRequest("POST", `/api/v1/sales/clients/${params.id}/${params.action}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ client: result.data }, { headers: NO_STORE });
}
