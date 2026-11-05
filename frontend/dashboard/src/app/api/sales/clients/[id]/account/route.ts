import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// A client's invoices, recent payments and outstanding balance per currency (nothing is converted or added across currencies). Read-only.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Client not found.", 404);
  const result = await salesRequest("GET", `/api/v1/sales/clients/${params.id}/account`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ account: result.data }, { headers: NO_STORE });
}
