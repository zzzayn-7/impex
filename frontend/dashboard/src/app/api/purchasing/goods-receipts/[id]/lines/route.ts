import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, isResponse, NO_STORE, parseReceiptLines, readObject, sessionToken } from "@/lib/purchasing-routes";
import { purchasingFailureResponse, purchasingRequest } from "@/lib/purchasing";

export const dynamic = "force-dynamic";

// REPLACE the lines of a DRAFT receipt with exactly these. Changes no stock; product, SKU, name and unit are taken from the order.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Goods receipt not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const lines = parseReceiptLines(body.lines);
  if (!lines.ok) return fail(lines.message, 400, lines.fieldErrors ? { fieldErrors: lines.fieldErrors } : {});
  const result = await purchasingRequest("PUT", `/api/v1/purchasing/goods-receipts/${params.id}/lines`, token, { lines: lines.lines });
  if (!result || result.status !== 200) return purchasingFailureResponse(result, "Goods receipt not found.");
  return NextResponse.json({ receipt: result.data }, { headers: NO_STORE });
}
