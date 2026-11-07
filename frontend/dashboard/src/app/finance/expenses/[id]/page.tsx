import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getExpense } from "@/lib/finance";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { BackLink, Missing, Unavailable } from "../../ui";
import ExpenseDetailView from "./expense-detail";

export const metadata: Metadata = {
  title: "Expense | Impex Organization Portal",
};

// Another organization's expense answers "not found", exactly like an id that does not exist.
export default async function ExpensePage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <BackLink href="/finance/expenses">All expenses</BackLink>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} what="Expense" />;
  const result = await getExpense(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} what="Expense" />;
    return <div className="space-y-4">{back}<Unavailable reason={result.reason} what="expenses" /></div>;
  }
  return (
    <div className="space-y-5">
      {back}
      <ExpenseDetailView expense={result.expense} />
    </div>
  );
}
