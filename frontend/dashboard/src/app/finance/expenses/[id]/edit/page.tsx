import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getExpense, getOverview, listAccounts } from "@/lib/finance";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { BackLink, Missing, Unavailable } from "../../../ui";
import ExpenseForm from "../../expense-form";

export const metadata: Metadata = {
  title: "Edit Expense | Impex Organization Portal",
};

// Only a DRAFT can be edited. A posted expense is corrected by reversing it and recording a new one.
export default async function EditExpensePage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <BackLink href={`/finance/expenses/${params.id}`}>Back to the expense</BackLink>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} what="Expense" />;
  const token = getTenantToken() ?? "";
  const [expense, accounts, overview] = await Promise.all([getExpense(token, params.id), listAccounts(token, { type: "expense" }), getOverview(token)]);
  for (const result of [expense, accounts, overview]) if (!result.ok && result.reason === "unauthorized") redirect("/login");
  if (!expense.ok) return expense.reason === "not-found" ? <Missing back={back} what="Expense" /> : <div className="space-y-4">{back}<Unavailable reason={expense.reason} what="expenses" /></div>;
  if (expense.expense.status !== "draft") {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          A posted expense can never be edited. To correct it, reverse it from its page and record a new expense.
        </p>
      </div>
    );
  }
  if (!accounts.ok || !overview.ok) return <div className="space-y-4">{back}<Unavailable reason="unavailable" what="expenses" /></div>;
  return (
    <div className="space-y-5">
      {back}
      <ExpenseForm categories={accounts.accounts} defaultCurrency={overview.overview.default_currency} expense={expense.expense} />
    </div>
  );
}
