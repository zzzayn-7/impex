import { NextRequest, NextResponse } from "next/server";

import { checkUuid, fail, NO_STORE, sessionToken } from "@/lib/sales-routes";
import { salesBinary, salesFailureResponse } from "@/lib/sales";

export const dynamic = "force-dynamic";

// The invoice as a PDF, built by the Sales Service from the saved invoice (the one template Print and Download share). The administrator's own session authorizes it; the file is
// never cached and building it is read-only. `?inline=1` is what Print uses: the same file, shown instead of saved.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Invoice not found.", 404);
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const result = await salesBinary(`/api/v1/sales/invoices/${params.id}/pdf${inline ? "?inline=true" : ""}`, token);
  if (!result || result.status !== 200 || !result.body) return salesFailureResponse(result, "Invoice not found.");
  // Only a filename made of safe characters is passed on.
  const name = /filename="([A-Za-z0-9._-]{1,64})"/.exec(result.contentDisposition ?? "")?.[1] ?? "invoice.pdf";
  return new NextResponse(result.body, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`, ...NO_STORE, "X-Content-Type-Options": "nosniff" },
  });
}
