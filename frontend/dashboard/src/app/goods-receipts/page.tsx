import { redirect } from "next/navigation";

import { SUPPLIER_INVOICES_HREF, forwardQuery } from "@/lib/invoices-nav";

// The goods receipt LIST is the Purchase Invoice history now. This old address (bookmarks, old links) forwards there with its supplier filter; the destination checks the
// session and the Purchasing module. A receipt's own page (/goods-receipts/<id>) is unchanged.
export default function GoodsReceiptsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  redirect(`${SUPPLIER_INVOICES_HREF}/history${forwardQuery(searchParams, ["supplier", "page"])}`);
}
