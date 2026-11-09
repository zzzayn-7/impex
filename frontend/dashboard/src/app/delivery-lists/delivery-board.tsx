"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { buttonClass } from "@/components/ui/controls";
import { useConfirm } from "@/components/ui/confirm";
import { GlassCard } from "@/components/dashboard/glass";
import { GlassPanel } from "@/components/ui/glass";
import { PageHeader, StatusBadge } from "@/components/ui/page";
import { Tooltip } from "@/components/ui/tooltip";
import type { Client, DeliveryListSummary, OrderSummary, Paged } from "@/lib/sales";
import { BOOKING_LABELS, FULFILMENT_LABELS, ORDER_STATUS_LABELS, RESERVATION_LABELS, STATUS_LABELS, api, jsonBody } from "@/lib/sales-browser";
import { EditOrderModal, ViewListModal, orderTone, stamp } from "./order-modals";

type Modal = { kind: "view" | "edit"; id: string } | null;

// DELIVERY LISTS: every sales order is a delivery list. An ACTIVE order shows as a card with exactly three actions - Edit, Remove, View List. View
// List opens a centered dialog (never a separate page). A fully delivered order moves to Delivered History for 24 hours (the Sales Service applies
// the cutoff on its own clock) and is then no longer listed; nothing is deleted.
export default function DeliveryBoard({ view, orders, others, clients, created }: {
  view: "active" | "history";
  orders: Paged<OrderSummary>;
  others: Paged<DeliveryListSummary> | null;
  clients: Client[];
  created: string | null;
}) {
  const router = useRouter();
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(created ? { ok: true, text: `${created} was saved. Its stock is reserved and its delivery list is ready for dispatch.` } : null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dispatchedOn, setDispatchedOn] = useState<Record<string, string>>({}); // orders dispatched on this page: order id -> date. They stay on the card until the page is reloaded.
  const [filter, setFilter] = useState("");
  const [confirm, dialog] = useConfirm();

  const items = orders.ok ? orders.items : [];
  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return term ? items.filter((o) => `${o.number} ${o.client.name} ${o.delivery_list.number}`.toLowerCase().includes(term)) : items;
  }, [items, filter]);

  function refresh(text?: string) {
    if (text) setMessage({ ok: true, text });
    router.refresh();
  }

  async function remove(order: OrderSummary) {
    const partly = order.delivery_list.status === "partially_dispatched";
    const ok = await confirm(
      partly
        ? {
            title: `Cancel the remaining quantity of ${order.number}?`,
            message: "Goods were already dispatched, so the order itself cannot be removed. The quantity that has not been delivered is cancelled and its reserved stock is released; what was dispatched stays exactly as it is.",
            confirmLabel: "Cancel remaining quantity",
          }
        : {
            title: `Remove ${order.number}?`,
            message: `The order for ${order.client.name} and its delivery list ${order.delivery_list.number} are cancelled and all the stock reserved for them is released. A record of the cancelled order is kept.`,
            confirmLabel: "Remove order",
          },
    );
    if (!ok) return;
    setBusyId(order.id);
    setMessage(null);
    const r = await api(`/api/sales/orders/${order.id}/${partly ? "cancel-remaining" : "cancel"}`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    refresh(partly ? `${order.number}: the undelivered quantity was cancelled and its stock released.` : `${order.number} was removed and its stock released.`);
  }

  // DISPATCH: everything not yet dispatched leaves the inventory together. Asks first (Cancel / Confirm); the order then shows "Dispatched on <date>" and
  // loses its Edit, Remove and Dispatch buttons. The Sales Service does the work (see /api/sales/orders/[id]/dispatch); it is safe to repeat.
  async function dispatchNow(order: OrderSummary) {
    const ok = await confirm({
      title: `Dispatch ${order.number}?`,
      message: `All ${order.product_count} ${order.product_count === 1 ? "product" : "products"} of this order for ${order.client.name} will be dispatched and taken out of your inventory now. The order can no longer be edited or removed.`,
      confirmLabel: "Confirm",
      danger: false,
    });
    if (!ok) return;
    setBusyId(order.id);
    setMessage(null);
    const r = await api(`/api/sales/orders/${order.id}/dispatch`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (r.status === 202) return setMessage({ ok: false, text: `${order.number} is being posted to your inventory, but the Inventory Service has not confirmed it yet. Press Dispatch again to finish it; nothing is taken out twice.` });
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    const date: string = r.data?.dispatchedOn ?? new Date().toISOString().slice(0, 10);
    setDispatchedOn((done) => ({ ...done, [order.id]: date }));
    setMessage({ ok: true, text: `${order.number} was dispatched on ${date}. Its items were taken out of your inventory.` });
  }

  async function retry(order: OrderSummary) {
    setBusyId(order.id);
    const r = await api(`/api/sales/orders/${order.id}/reconcile`, { method: "POST" });
    setBusyId(null);
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    refresh(r.data?.pending ? undefined : `${order.number} is booked.`);
    if (r.data?.pending) setMessage({ ok: false, text: "The Inventory Service has not confirmed the booking yet. Try again in a moment; it cannot be booked twice." });
  }

  const tab = (href: string, label: string, current: boolean) => (
    <Link href={href} aria-current={current ? "page" : undefined} className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${current ? "bg-ix-accent/15 text-ix-butter shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-rgb)/0.3)]" : "text-ix-muted hover:bg-ix-mist/10 hover:text-ix-text"}`}>{label}</Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delivery Lists"
        subtitle="Every sales order becomes a delivery list. Its stock is reserved for it, and physical stock is deducted only when you confirm a dispatch."
        actions={<Link href="/sales-orders/new" className={buttonClass.primary}>Create Order</Link>}
      />

      {message && <div role={message.ok ? "status" : "alert"} className={`rounded-2xl border px-4 py-3 text-sm ${message.ok ? "border-ix-butter/30 bg-ix-butter/10 text-ix-butter" : "border-red-300/30 bg-red-400/10 text-red-200"}`}>{message.text}</div>}

      <nav aria-label="Delivery list views" className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-2xl border border-ix-mist/10 bg-ix-deep/30 p-1">
          {tab("/delivery-lists", "Active", view === "active")}
          {tab("/delivery-lists?view=history", "Delivered History", view === "history")}
        </div>
        {orders.ok && items.length > 1 && (
          <label className="text-xs font-medium text-ix-muted">
            <span className="sr-only">Filter these lists</span>
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by client or number" className="block w-64 max-w-full text-sm" />
          </label>
        )}
      </nav>

      {view === "history" && <p className="text-xs text-ix-muted">Fully delivered orders stay here for 24 hours after the last dispatch, then leave this list on their own. Their dispatches, stock movements, invoices and payments are never removed.</p>}

      {!orders.ok ? (
        <GlassPanel role="alert" className="p-5 text-sm text-ix-muted">
          {orders.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so orders cannot be used. Please contact your platform administrator." : "Delivery lists are temporarily unavailable. Please refresh in a moment."}
        </GlassPanel>
      ) : shown.length === 0 ? (
        <GlassPanel className="p-8 text-center text-sm text-ix-muted">
          {view === "history"
            ? "Nothing was fully delivered in the last 24 hours."
            : filter ? "No delivery lists match this filter." : (
              <>No active orders yet. <Link href="/sales-orders/new" className="font-medium text-ix-butter underline-offset-2 hover:underline">Create the first order</Link> and its delivery list appears here.</>
            )}
        </GlassPanel>
      ) : (
        <ul aria-label={view === "history" ? "Delivered orders" : "Active delivery lists"} className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,21rem),1fr))]">
          {shown.map((order) => {
            const finishedOn = dispatchedOn[order.id] ?? (order.status === "delivered" && order.completed_at ? order.completed_at.slice(0, 10) : null);
            return (
            <li key={order.id}>
              <GlassCard className="flex h-full flex-col gap-4 p-5" data-order={order.number} lift>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-ix-text">{order.client.name}</h3>
                    <p className="mt-0.5 font-mono text-xs text-ix-butter">{order.number} <span className="text-ix-muted">· {order.delivery_list.number}</span></p>
                  </div>
                  {finishedOn ? (
                    <StatusBadge tone={orderTone("delivered")}>Dispatched on {finishedOn}</StatusBadge>
                  ) : view === "active" ? (
                    <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5">
                      <Tooltip label="Edit">
                        <button type="button" onClick={() => setModal({ kind: "edit", id: order.id })} disabled={order.status !== "active" || busyId === order.id} aria-label={`Edit ${order.number}`} className="p-1.5 text-ix-muted transition-colors hover:text-ix-text focus-visible:outline-none focus-visible:text-ix-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ix-muted">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" /></svg>
                        </button>
                      </Tooltip>
                      <Tooltip label="Remove">
                        <button type="button" onClick={() => remove(order)} disabled={order.status !== "active" || busyId === order.id} aria-label={`Remove ${order.number}`} className="p-1.5 text-red-400 transition-colors hover:text-red-300 focus-visible:outline-none focus-visible:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-red-400">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
                    <StatusBadge tone={orderTone(order.status)}>{ORDER_STATUS_LABELS[order.status]}</StatusBadge>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div><dt className="text-ix-muted">{view === "history" ? "Delivered" : "Created"}</dt><dd className="mt-0.5 text-ix-text">{stamp(view === "history" ? order.completed_at : order.created_at)}</dd></div>
                  <div><dt className="text-ix-muted">Products</dt><dd className="mt-0.5 text-ix-text">{order.product_count}</dd></div>
                  <div><dt className="text-ix-muted">Fulfilment</dt><dd className="mt-0.5 text-ix-text">{finishedOn ? FULFILMENT_LABELS.dispatched : FULFILMENT_LABELS[order.delivery_list.status] ?? order.delivery_list.status}</dd></div>
                  <div><dt className="text-ix-muted">{view === "history" ? "Leaves history" : "Reservation"}</dt><dd className="mt-0.5 text-ix-text">{view === "history" ? stamp(order.history_expires_at) : finishedOn ? RESERVATION_LABELS.consumed : RESERVATION_LABELS[order.reservation_status]}</dd></div>
                </dl>
                {order.status === "pending_reservation" && (
                  <p role="status" className="rounded-xl border border-amber-200/25 bg-amber-100/10 px-3 py-2 text-xs text-amber-100">
                    The stock booking is not confirmed yet, so nothing is treated as booked.
                    <button type="button" onClick={() => retry(order)} disabled={busyId === order.id} className="ml-2 font-semibold underline underline-offset-2">Retry booking</button>
                  </p>
                )}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
                  <button type="button" onClick={() => setModal({ kind: "view", id: order.id })} aria-label={`View list ${order.number}`} className={buttonClass.secondary}>View List</button>
                  {view === "active" && !finishedOn && (
                    <button
                      type="button"
                      onClick={() => dispatchNow(order)}
                      disabled={busyId === order.id || order.status !== "active" || !(order.delivery_list.status === "ready" || order.delivery_list.status === "partially_dispatched")}
                      aria-label={`Dispatch ${order.number}`}
                      className={buttonClass.primary}
                    >
                      {busyId === order.id ? "Dispatching…" : "Dispatch"}
                    </button>
                  )}
                </div>
              </GlassCard>
            </li>
            );
          })}
        </ul>
      )}

      {view === "active" && others && <OtherLists others={others} clients={clients} onChanged={refresh} />}

      {modal?.kind === "view" && <ViewListModal orderId={modal.id} onClose={() => setModal(null)} />}
      {modal?.kind === "edit" && <EditOrderModal orderId={modal.id} onClose={() => setModal(null)} onSaved={(text) => { setModal(null); refresh(text); }} />}
      {dialog}
    </div>
  );
}

// Drafts (scanned or typed) and OLDER lists made before stock reservations existed. A draft books its stock when it is marked Ready; an older
// Ready list can be booked here; an older list that already has goods dispatched needs reconciliation by hand and is never booked silently.
function OtherLists({ others, clients, onChanged }: { others: Paged<DeliveryListSummary>; clients: Client[]; onChanged: (text?: string) => void }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const open = others.ok ? others.items.filter((l) => l.status === "draft" || l.status === "ready" || l.status === "partially_dispatched") : [];

  async function book(list: DeliveryListSummary) {
    setBusyId(list.id);
    setMessage(null);
    const r = await api(`/api/sales/delivery-lists/${list.id}/book`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage(r.error);
    onChanged(`${list.number} is booked as ${r.data.order.number}: its stock is reserved.`);
  }

  // Remove = cancel the list. Nothing was reserved for a draft or an older list, so no stock changes; the record is kept. The Sales Service refuses a
  // list that already has goods dispatched, and the button is disabled for it.
  async function removeList(list: DeliveryListSummary) {
    const ok = await confirm({
      title: `Remove ${list.number}?`,
      message: `The delivery list for ${list.client.name} is cancelled. No stock was reserved for it, so no stock changes. A record of the cancelled list is kept.`,
      confirmLabel: "Remove list",
    });
    if (!ok) return;
    setBusyId(list.id);
    setMessage(null);
    const r = await api(`/api/sales/delivery-lists/${list.id}/cancel`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage(r.error);
    onChanged(`${list.number} was removed.`);
  }

  if (!others.ok || (open.length === 0 && !creating)) {
    return (
      <div className="flex justify-end">
        <button type="button" onClick={() => setCreating(true)} className="text-xs text-ix-muted underline-offset-2 hover:text-ix-butter hover:underline">New draft delivery list</button>
      </div>
    );
  }
  return (
    <GlassPanel className="space-y-4 p-5" aria-labelledby="other-lists-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="other-lists-heading" className="text-[15px] font-semibold text-ix-text">Draft and older lists</h3>
          <p className="mt-0.5 text-xs text-ix-muted">Lists that are not a sales order yet. Marking a draft Ready books its stock. Older Ready lists were made before stock could be reserved.</p>
        </div>
        <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating} className={buttonClass.secondary}>{creating ? "Close" : "New draft list"}</button>
      </div>
      {message && <p role="alert" className="rounded-xl border border-red-300/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{message}</p>}
      {creating && <NewListForm clients={clients.filter((c) => c.is_active)} onCancel={() => setCreating(false)} />}
      {open.length > 0 && (
        <div className="ix-inset overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-sm">
            <caption className="sr-only">Draft and older delivery lists</caption>
            <thead className="text-[11px] uppercase tracking-wide text-ix-muted">
              <tr><th scope="col" className="w-12 px-3 py-2.5"><span className="sr-only">Remove</span></th><th scope="col" className="px-3 py-2.5 font-medium">List</th><th scope="col" className="px-3 py-2.5 font-medium">Client</th><th scope="col" className="px-3 py-2.5 font-medium">Status</th><th scope="col" className="px-3 py-2.5 text-right font-medium">Items</th><th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-ix-mist/10">
              {open.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2.5">
                    <Tooltip label={l.status === "partially_dispatched" ? "Goods were already dispatched: this list cannot be removed" : `Remove ${l.number}`} side="right">
                      <button
                        type="button"
                        onClick={() => removeList(l)}
                        disabled={busyId === l.id || l.status === "partially_dispatched" || l.status === "dispatched"}
                        aria-label={`Remove ${l.number}`}
                        className="grid h-9 w-9 place-items-center rounded-xl border border-red-300/30 bg-red-400/10 text-red-300 transition-colors hover:border-red-300/60 hover:bg-red-400/20 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                      </button>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2.5"><Link href={`/delivery-lists/${l.id}`} className="font-mono text-sm font-semibold text-ix-butter hover:text-ix-text">{l.number}</Link></td>
                  <td className="px-3 py-2.5">{l.client.name}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <StatusBadge tone={l.booking_state === "unbooked_partial" ? "warning" : "neutral"}>{l.booking_state && BOOKING_LABELS[l.booking_state] ? BOOKING_LABELS[l.booking_state] : STATUS_LABELS[l.status]}</StatusBadge>
                    <span className="ml-2 text-ix-muted">{STATUS_LABELS[l.status]}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">{l.item_count}</td>
                  <td className="px-3 py-2.5 text-right">
                    {l.booking_state === "unbooked" && (
                      <Tooltip label="Reserve all of this list's quantities now"><button type="button" onClick={() => book(l)} disabled={busyId === l.id} className={buttonClass.secondary}>{busyId === l.id ? "Booking…" : "Book stock"}</button></Tooltip>
                    )}
                    {l.booking_state === "unbooked_partial" && <span className="text-xs text-amber-200">Goods already dispatched: finish it with its dispatches</span>}
                    {l.booking_state === "draft" && <Link href={`/delivery-lists/${l.id}`} className={buttonClass.secondary}>Open</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog}
    </GlassPanel>
  );
}

function NewListForm({ clients, onCancel }: { clients: Client[]; onCancel: () => void }) {
  const router = useRouter();
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!clientId) return setError("Choose a client.");
    setBusy(true);
    const r = await api("/api/sales/delivery-lists", { method: "POST", ...jsonBody({ clientId }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    router.push(`/delivery-lists/${r.data.list.id}`);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="New delivery list" className="space-y-3 rounded-2xl border border-ix-butter/20 bg-ix-deep/30 p-4">
      <h4 className="text-sm font-semibold text-ix-text">New draft delivery list</h4>
      <p className="text-xs text-ix-muted">A draft reserves nothing. Add products (or scan them) and mark it Ready to book the stock. To book stock straight away, use Create Order instead.</p>
      {error && <div role="alert" className="rounded-xl border border-red-300/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>}
      <label className="block text-xs font-medium text-ix-muted">
        Client
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="mt-1.5 block w-full text-sm">
          <option value="">{clients.length ? "Choose a client…" : "No clients yet"}</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={buttonClass.secondary}>Cancel</button>
        <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? "Creating…" : "Create draft"}</button>
      </div>
    </form>
  );
}
