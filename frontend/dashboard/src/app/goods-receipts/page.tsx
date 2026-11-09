import { redirect } from "next/navigation";

import { RECEIPT_LIST_PARAMS, SUPPLIER_INVOICES_HREF, forwardQuery } from "@/lib/invoices-nav";

// The goods receipt LIST now lives in Invoices > Suppliers Invoice. This old address (bookmarks, old links) forwards there with its search and filters
// intact; the destination checks the session and the Purchasing module. A receipt's own page (/goods-receipts/<id>) is unchanged.
export default function GoodsReceiptsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  redirect(`${SUPPLIER_INVOICES_HREF}${forwardQuery(searchParams, RECEIPT_LIST_PARAMS)}`);
}
