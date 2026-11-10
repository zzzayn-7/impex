import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, checkUuid, fail, isResponse, NO_STORE, parseReconcileBody, readObject, sessionToken } from "@/lib/finance-routes";

export const dynamic = "force-dynamic";

// Settle a delivery that had no recorded price or no reliable cost, by hand: what is entered is final and audited by the Finance Service.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Delivery not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseReconcileBody(body);
  if (!parsed.ok) return badParse(parsed);
  const result = await financeRequest("POST", `/api/v1/finance/deliveries/${params.id}/reconcile`, token, parsed.value);
  if (!result || result.status !== 200) return financeFailureResponse(result, "Delivery not found.");
  return NextResponse.json({ delivery: result.data }, { headers: NO_STORE });
}
