import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, parseDispatchLines, readObject, sessionToken } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// REPLACE the lines of a DRAFT dispatch with exactly these. Changes no stock; product, SKU, name and unit are taken from the delivery list.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Dispatch not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const lines = parseDispatchLines(body.lines);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});
  const result = await salesRequest("PUT", `/api/v1/sales/dispatches/${params.id}/lines`, token, { lines: lines.lines });
  if (!result || result.status !== 200) return salesFailureResponse(result, "Dispatch not found.");
  return NextResponse.json({ dispatch: result.data }, { headers: NO_STORE });
}
