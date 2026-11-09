import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, parseOrderLines, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";
import { IDEMPOTENCY_KEY_RE } from "@/lib/stock-validation";

export const dynamic = "force-dynamic";

// List the signed-in administrator's orders: view=active (still to be delivered) or view=delivered (completed within the last 24 hours;
// the cutoff is applied by the Sales Service on its own clock).
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams({ view: p.get("view") === "delivered" ? "delivered" : "active" });
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "100", 10) || 100))));
  const result = await salesRequest("GET", `/api/v1/sales/orders?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// SAVE an order: a client and the products required. The stock is booked at once (all lines or none) and a linked delivery list is generated.
// The browser sends an Idempotency-Key per intended order (generated once per form), so a double click or a retry returns the same order and
// books nothing twice. 201 = created, 200 = this exact request had already been processed, 202 = saved but the booking is not confirmed yet.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return fail("Missing or invalid request key. Reload the page and try again.", 400);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const clientId = checkUuid(body.clientId);
  if (!clientId) return fail("Choose a client.", 400, { fieldErrors: { clientId: "Choose a client." } });
  const lines = parseOrderLines(body.lines);
  if (!lines.ok) return fail(lines.message, 400);
  const notes = text(body.notes) ?? "";
  if (notes.length > 2000) return fail("Use 2000 characters or fewer for the notes.", 400, { fieldErrors: { notes: "Use 2000 characters or fewer." } });

  const result = await salesRequest("POST", "/api/v1/sales/orders", token, { client_id: clientId, lines: lines.lines, ...(notes ? { notes } : {}) }, { "Idempotency-Key": key });
  if (!result || ![200, 201, 202].includes(result.status)) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ order: result.data, pending: result.status === 202, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
