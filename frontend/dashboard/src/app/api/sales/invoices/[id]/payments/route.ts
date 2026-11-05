import { NextRequest, NextResponse } from "next/server";

import { checkDispatchDate, checkMoney, checkUuid, collapse, fail, isResponse, NO_STORE, PAYMENT_METHODS, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// RECORD a payment received against an issued invoice (by hand: nothing is collected from a bank or card). The browser sends an
// Idempotency-Key per payment form, so a double click or a retry records it once (the retry answers 200 with the same invoice). Only the
// amount, the method, the date, a reference and a note are read: the currency is always the invoice's, and the recorder is the signed-in
// administrator. A payment above the outstanding amount is refused by the Sales Service.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const amount = checkMoney(body.amount, false);
  const method = typeof body.method === "string" && (PAYMENT_METHODS as readonly string[]).includes(body.method) ? body.method : null;
  const paymentDate = text(body.paymentDate) ?? "";
  const reference = collapse(text(body.reference) ?? "");
  const notes = text(body.notes) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (!amount) fieldErrors.amount = "Enter the amount received (greater than zero, at most 4 decimals).";
  if (!method) fieldErrors.method = "Choose how the payment was made.";
  if (paymentDate && !checkDispatchDate(paymentDate)) fieldErrors.paymentDate = "Enter a valid date.";
  if (reference.length > 100) fieldErrors.reference = "Use 100 characters or fewer.";
  if (notes.length > 500) fieldErrors.notes = "Use 500 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await salesRequest(
    "POST", `/api/v1/sales/invoices/${params.id}/payments`, token,
    { amount, method, reference, notes, ...(paymentDate ? { payment_date: paymentDate } : {}) },
    { "Idempotency-Key": key }
  );
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Invoice not found.");
  return NextResponse.json({ invoice: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
