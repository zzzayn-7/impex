import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ExpenseFilters, listAccounts, listExpenses } from "@/lib/finance";
import { EXPENSE_STATUSES } from "@/lib/finance-routes";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ExpenseIndex from "./expense-index";

export const metadata: Metadata = {
  title: "Expenses | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only search text, status, category, currency, two dates and the page number are read from the URL. There is no organization parameter.
function parseFilters(searchParams: SearchParams): ExpenseFilters {
  const status = first(searchParams.status) ?? "";
  const currency = (first(searchParams.currency) ?? "").trim().toUpperCase();
  const account = (first(searchParams.category) ?? "").trim();
  const from = (first(searchParams.from) ?? "").trim();
  const to = (first(searchParams.to) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: (EXPENSE_STATUSES as readonly string[]).includes(status) ? (status as ExpenseFilters["status"]) : "",
    accountId: UUID_RE.test(account) ? account : "",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "",
    dateFrom: DATE_RE.test(from) ? from : "",
    dateTo: DATE_RE.test(to) ? to : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function ExpensesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, accounts] = await Promise.all([listExpenses(token, filters), listAccounts(token, { type: "expense" })]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <ExpenseIndex list={list} filters={filters} categories={accounts.ok ? accounts.accounts : []} />;
}
