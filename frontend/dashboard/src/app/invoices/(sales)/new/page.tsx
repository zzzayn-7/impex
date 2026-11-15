import { redirect } from "next/navigation";

import { SALES_INVOICES_HREF } from "@/lib/invoices-nav";

// Invoices are made from a prepared order now (Sales Invoice > New invoice). This old address (bookmarks, old links) goes there; the destination checks the session and the Sales module.
export default function NewInvoicePage() {
  redirect(SALES_INVOICES_HREF);
}
