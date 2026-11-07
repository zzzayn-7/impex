import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryFilters, listAccounts, listEntries } from "@/lib/finance";
import { ENTRY_SOURCES, ENTRY_STATUSES } from "@/lib/finance-routes";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import EntryIndex from "./entry-index";

export const metadata: Metadata = {
  title: "Journal Entries | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only search text, status, source, currency, account, two dates and the page number are read from the URL. There is no organization parameter:
// whose entries are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): EntryFilters {
  const status = first(searchParams.status) ?? "";
  const source = first(searchParams.source) ?? "";
  const currency = (first(searchParams.currency) ?? "").trim().toUpperCase();
  const account = (first(searchParams.account) ?? "").trim();
  const from = (first(searchParams.from) ?? "").trim();
  const to = (first(searchParams.to) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: (ENTRY_STATUSES as readonly string[]).includes(status) ? (status as EntryFilters["status"]) : "",
    source: (ENTRY_SOURCES as readonly string[]).includes(source) ? (source as EntryFilters["source"]) : "",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "",
    accountId: UUID_RE.test(account) ? account : "",
    dateFrom: DATE_RE.test(from) ? from : "",
    dateTo: DATE_RE.test(to) ? to : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function JournalPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, accounts] = await Promise.all([listEntries(token, filters), listAccounts(token)]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <EntryIndex list={list} filters={filters} accounts={accounts.ok ? accounts.accounts : []} />;
}
