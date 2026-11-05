import { NextRequest, NextResponse } from "next/server";

import { checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// List / search delivery lists of the signed-in administrator's organization (e.g. all drafts, for the Scan page).
export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const p = req.nextUrl.searchParams;
  const params = new URLSearchParams();
  const status = p.get("status");
  if (status === "draft" || status === "ready" || status === "partially_dispatched" || status === "dispatched" || status === "cancelled") params.set("status", status);
  const clientId = p.get("clientId");
  if (clientId) {
    if (!checkUuid(clientId)) return fail("Client not found.", 404);
    params.set("client_id", clientId);
  }
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(Math.max(1, Math.min(200, parseInt(p.get("limit") ?? "50", 10) || 50))));
  params.set("offset", String(Math.max(0, parseInt(p.get("offset") ?? "0", 10) || 0)));
  const result = await salesRequest("GET", `/api/v1/sales/delivery-lists?${params}`, token);
  if (!result || result.status !== 200) return salesFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// CREATE a draft delivery list for one of the administrator's clients. The number, status and owner are decided by the
// Sales Service; only the client, an optional reference and optional notes are read from the browser.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const clientId = checkUuid(body.clientId);
  if (!clientId) return fail("Choose a client.", 400, { fieldErrors: { clientId: "Choose a client." } });
  const reference = collapse(text(body.externalReference) ?? "");
  const notes = text(body.notes) ?? "";
  const fieldErrors: Record<string, string> = {};
  if (reference.length > 100) fieldErrors.externalReference = "Use 100 characters or fewer.";
  if (notes.length > 2000) fieldErrors.notes = "Use 2000 characters or fewer.";
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await salesRequest("POST", "/api/v1/sales/delivery-lists", token, { client_id: clientId, external_reference: reference, notes });
  if (!result || result.status !== 201) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ list: result.data }, { status: 201, headers: NO_STORE });
}
