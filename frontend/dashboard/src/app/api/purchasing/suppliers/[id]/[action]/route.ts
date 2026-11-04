import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

// ACTIVATE / DEACTIVATE a supplier (soft state change; nothing is deleted).
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (params.action !== "activate" && params.action !== "deactivate") return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Supplier not found.", 404);
  const result = await purchasingRequest("POST", `/api/v1/purchasing/suppliers/${params.id}/${params.action}`, token);
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Supplier not found.");
  return NextResponse.json({ supplier: result.data }, { headers: NO_STORE });
}
