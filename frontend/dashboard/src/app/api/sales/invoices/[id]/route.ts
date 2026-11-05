import { NextRequest, NextResponse } from "next/server";

import { checkDispatchDate, checkUuid, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  const result = await salesRequest("GET", `/api/v1/sales/invoices/${params.id}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Invoice not found.");
  return NextResponse.json({ invoice: result.data }, { headers: NO_STORE });
}

// Edit the dates or the note of a DRAFT invoice (an issued invoice is frozen: the Sales Service refuses).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const changes: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [name, upstream] of [["invoiceDate", "invoice_date"], ["dueDate", "due_date"]] as const) {
    if (body[name] === undefined) continue;
    const date = text(body[name]) ?? "";
    if (!checkDispatchDate(date)) fieldErrors[name] = "Enter a valid date.";
    else changes[upstream] = date;
  }
  if (body.notes !== undefined) {
    const notes = text(body.notes) ?? "";
    if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
    else changes.notes = notes;
  }
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  if (Object.keys(changes).length === 0) return fail("Nothing to change.", 400);
  const result = await salesRequest("PATCH", `/api/v1/sales/invoices/${params.id}`, token, changes);
  if (!result || result.status !== 200) return salesFailureResponse(result, "Invoice not found.");
  return NextResponse.json({ invoice: result.data }, { headers: NO_STORE });
}
