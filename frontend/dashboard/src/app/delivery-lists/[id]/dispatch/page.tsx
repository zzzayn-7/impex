import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { loadStockSummary } from "@/lib/inventory";
import { getDeliveryList, getDispatch } from "@/lib/sales";
import { STATUS_LABELS } from "@/lib/sales-browser";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DispatchForm from "./dispatch-form";

export const metadata: Metadata = {
  title: "Prepare Dispatch | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Which list, and which draft to resume, come from the URL; whose they are is decided by the Sales Service from the session.
// Another organization's list or dispatch answers "not found", exactly like an id that does not exist.
export default async function PrepareDispatchPage({ params, searchParams }: { params: { id: string }; searchParams: SearchParams }) {
  await requireTenantAdmin();
  const back = <Link href={UUID_RE.test(params.id) ? `/delivery-lists/${params.id}` : "/delivery-lists"} className="text-xs text-indigo-300 hover:text-indigo-200">← Back to the delivery list</Link>;
  if (!UUID_RE.test(params.id)) return <Message back={back} text="Delivery list not found." />;

  const token = getTenantToken() ?? "";
  const result = await getDeliveryList(token, params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Message back={back} text="Delivery list not found." />;
    return <Message back={back} text={result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so goods cannot be dispatched. Please contact your platform administrator." : "This delivery list is temporarily unavailable. Please refresh in a moment."} />;
  }
  const list = result.list;

  let draft = null;
  const resume = (first(searchParams?.dispatch) ?? "").trim();
  if (UUID_RE.test(resume)) {
    const found = await getDispatch(token, resume);
    if (found.ok && found.dispatch.delivery_list.id === list.id && found.dispatch.status === "draft") draft = found.dispatch;
  }

  if (!list.can_dispatch) {
    return (
      <div className="space-y-4">
        {back}
        <h2 className="font-mono text-xl font-semibold text-white">{list.number}</h2>
        <p role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {list.status === "draft" && `${list.number} is still a draft. Mark it Ready before dispatching goods against it.`}
          {list.status === "cancelled" && `${list.number} is cancelled. Goods cannot be dispatched against it.`}
          {list.status === "dispatched" && `${list.number} is already fully dispatched. There is nothing left to dispatch.`}
          {!["draft", "cancelled", "dispatched"].includes(list.status) && `${list.number} is ${STATUS_LABELS[list.status]}; there is nothing left to dispatch right now (goods being posted are reserved until they are confirmed).`}
        </p>
      </div>
    );
  }

  const stock = await loadStockSummary(token, list.items.map((i) => i.product_id));
  return (
    <div className="space-y-5">
      {back}
      <div>
        <h2 className="text-xl font-semibold text-white">Prepare dispatch · <span className="font-mono">{list.number}</span></h2>
        <p className="text-xs text-slate-400">For {list.client.name}. Choose what leaves, review the stock on hand, then confirm to deduct it.</p>
      </div>
      <DispatchForm key={draft?.id ?? "new"} list={list} stock={stock} draft={draft} />
    </div>
  );
}

function Message({ back, text }: { back: React.ReactNode; text: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
}
