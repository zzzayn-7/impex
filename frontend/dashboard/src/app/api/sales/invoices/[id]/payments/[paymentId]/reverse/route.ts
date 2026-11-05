import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// CORRECT a mistaken payment by recording its REVERSAL, with a reason. The payment itself is never edited or deleted: both records stay on
// the invoice. A payment can be reversed once. The Idempotency-Key makes a double click harmless.
export async function POST(req: NextRequest, { params }: { params: { id: string; paymentId: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  if (!checkUuid(params.paymentId)) return fail("Payment not found.", 404);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const reason = text(body.reason) ?? "";
  if (!reason) return fail("Give the reason for reversing this payment.", 400, { fieldErrors: { reason: "Give the reason." } });
  if (reason.length > 500) return fail("Use 500 characters or fewer for the reason.", 400, { fieldErrors: { reason: "Use 500 characters or fewer." } });
  const result = await salesRequest("POST", `/api/v1/sales/invoices/${params.id}/payments/${params.paymentId}/reverse`, token, { reason }, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Payment not found.");
  return NextResponse.json({ invoice: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
