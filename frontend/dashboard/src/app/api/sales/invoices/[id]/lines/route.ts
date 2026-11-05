import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, parseInvoiceLines, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// REPLACE the lines of a DRAFT invoice with exactly these. Changes no stock; names, units and every total come from the Sales Service.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const lines = parseInvoiceLines(body.lines);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});
  const result = await salesRequest("PUT", `/api/v1/sales/invoices/${params.id}/lines`, token, { lines: lines.lines });
  if (!result || result.status !== 200) return salesFailureResponse(result, "Invoice not found.");
  return NextResponse.json({ invoice: result.data }, { headers: NO_STORE });
}
