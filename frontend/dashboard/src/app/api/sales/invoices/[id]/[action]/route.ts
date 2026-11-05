import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const ACTIONS = ["issue", "void"];

// ISSUE freezes a draft and gives it its number; calling it again is always safe. VOID discards a draft or an unpaid issued invoice (an
// invoice with payments on record is refused: reverse the payments first). Neither ever touches stock.
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!ACTIONS.includes(params.action)) return fail("Not found.", 404);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  let body: unknown;
  if (params.action === "void") {
    const parsed = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const reason = text(parsed?.reason) ?? "";
    if (reason.length > 500) return fail("Use 500 characters or fewer for the reason.", 400, { fieldErrors: { reason: "Use 500 characters or fewer." } });
    body = { reason: reason || null };
  }
  const result = await salesRequest("POST", `/api/v1/sales/invoices/${params.id}/${params.action}`, token, body);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Invoice not found.");
  return NextResponse.json({ invoice: result.data }, { headers: NO_STORE });
}
