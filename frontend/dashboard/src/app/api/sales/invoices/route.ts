import { NextRequest, NextResponse } from "next/server";

import {
  checkCurrency, checkDispatchDate, checkUuid, fail, INVOICE_STATUSES, isResponse, NO_STORE, parseInvoiceLines, PAYMENT_FILTERS, readObject, sessionToken, text,
} from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// List / search the invoices of the signed-in administrator's organization.
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) params.set("status", status);
  const paymentStatus = p.get("paymentStatus");
  if (paymentStatus && (PAYMENT_FILTERS as readonly string[]).includes(paymentStatus)) params.set("payment_status", paymentStatus);
  const client = p.get("clientId");
  if (client) {
    if (!checkUuid(client)) return fail("Not found.", 404);
    params.set("client_id", client);
  }
  for (const [name, upstream] of [["dateFrom", "date_from"], ["dateTo", "date_to"]] as const) {
    const value = p.get(name);
    if (value) {
      if (!checkDispatchDate(value)) return fail("Enter a valid date.", 400);
      params.set(upstream, value);
    }
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await salesRequest("GET", `/api/v1/sales/invoices?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// Start a DRAFT invoice for a client from CONFIRMED dispatch lines. Never touches stock.
//
// The browser sends an Idempotency-Key with every create (generated once per form), so a double click or a retry returns the same draft.
// Only the client id, the currency, the dates, a note and the lines (dispatch line id, exact quantity, selling price, discount, tax rate and
// label) are read. Product, SKU, name, unit, totals, number, status, owner and organization are decided by the Sales Service.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const clientId = checkUuid(body.clientId);
  if (!clientId) return fail("Client not found.", 404);
  const currency = checkCurrency(body.currencyCode);
  const invoiceDate = text(body.invoiceDate) ?? "";
  const dueDate = text(body.dueDate) ?? "";
  const notes = text(body.notes) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (!currency) fieldErrors.currencyCode = "Use a 3-letter currency code such as USD, EUR or PKR.";
  if (invoiceDate && !checkDispatchDate(invoiceDate)) fieldErrors.invoiceDate = "Enter a valid date.";
  if (dueDate && !checkDispatchDate(dueDate)) fieldErrors.dueDate = "Enter a valid date.";
  if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });
  const lines = parseInvoiceLines(body.lines ?? []);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});

  const result = await salesRequest(
    "POST", "/api/v1/sales/invoices", token,
    { client_id: clientId, currency_code: currency, notes, lines: lines.lines, ...(invoiceDate ? { invoice_date: invoiceDate } : {}), ...(dueDate ? { due_date: dueDate } : {}) },
    { "Idempotency-Key": key }
  );
  if (!result || (result.status !== 201 && result.status !== 200)) return salesFailureResponse(result, "Client not found.");
  // 201 = created now, 200 = this exact request had already been processed (a retry): the browser treats both as success.
  return NextResponse.json({ invoice: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
