"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import OrderLinesEditor from "@/components/sales/order-lines-editor";
import { buttonClass } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/page";
import { type OrderRow, orderLines, orderTotal, priceErrors as rowPriceErrors, rowErrors } from "@/lib/order-form";
import { formatMoney, plainDecimal } from "@/lib/product-validation";
import type { OrderDetail, OrderLine } from "@/lib/sales";
import { FULFILMENT_LABELS, ORDER_STATUS_LABELS, RESERVATION_LABELS, addDecimal, api, jsonBody, qty } from "@/lib/sales-browser";

export const stamp = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");

export function orderTone(status: string): "success" | "warning" | "danger" | "neutral" | "muted" | "pending" {
  return status === "active" ? "success" : status === "pending_reservation" ? "warning" : status === "failed" ? "danger" : status === "delivered" || status === "closed" ? "neutral" : "muted";
}

/** Load one order (with its live stock) from the portal's own route. */
function useOrder(id: string) {
  const [state, setState] = useState<{ loading: boolean; order: OrderDetail | null; error: string | null }>({ loading: true, order: null, error: null });
  useEffect(() => {
    let alive = true;
    void api(`/api/sales/orders/${id}`).then((r) => {
      if (!alive) return;
      setState(r.ok ? { loading: false, order: r.data.order as OrderDetail, error: null } : { loading: false, order: null, error: r.error });
    });
    return () => { alive = false; };
  }, [id]);
  return state;
}

// =====================================================================================================================================
// VIEW LIST: a centered, scrollable glass dialog (never a separate page)
// =====================================================================================================================================
export function ViewListModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { loading, order, error } = useOrder(orderId);
  return (
    <Modal
      title={order ? `${order.number} · ${order.client.name}` : "Delivery list"}
      subtitle={order ? `Delivery list ${order.delivery_list.number}` : undefined}
      onClose={onClose}
      size="xl"
      footer={
        <>
          {order && order.can_dispatch && <Link href={`/delivery-lists/${order.delivery_list.id}/dispatch`} className={buttonClass.primary}>Prepare dispatch</Link>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>Close</button>
        </>
      }
    >
      {loading && <div role="status" aria-label="Loading the list" className="space-y-3"><div className="ix-skeleton h-16" /><div className="ix-skeleton h-40" /></div>}
      {error && <p role="alert" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{error}</p>}
      {order && <ListBody order={order} />}
    </Modal>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-ix-mist/10 bg-ix-deep/25 px-3.5 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-ix-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-ix-text">{children}</dd>
    </div>
  );
}

function ListBody({ order }: { order: OrderDetail }) {
  const fulfilment = FULFILMENT_LABELS[order.delivery_list.status] ?? order.delivery_list.status;
  return (
    <div className="space-y-5">
      {order.message && <p role="status" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{order.message}</p>}
      {order.last_error && order.status === "active" && <p role="alert" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{order.last_error}</p>}
      <dl className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Client">{order.client.name}</Fact>
        <Fact label="Sales order">{order.number}</Fact>
        <Fact label="Delivery list">{order.delivery_list.number}</Fact>
        <Fact label="Created">{stamp(order.created_at)}</Fact>
        <Fact label="Order status"><StatusBadge tone={orderTone(order.status)}>{ORDER_STATUS_LABELS[order.status]}</StatusBadge> <span className="ml-1 text-xs font-normal text-ix-muted">{fulfilment}</span></Fact>
        <Fact label="Reservation"><StatusBadge tone={order.reservation_status === "reserved" ? "success" : "neutral"}>{RESERVATION_LABELS[order.reservation_status]}</StatusBadge></Fact>
        <Fact label="Order total">
          {order.total_amount && order.currency_code ? <span data-testid="view-order-total">{formatMoney(order.total_amount, order.currency_code)}</span> : <span className="font-normal text-ix-muted" title="This order was made before agreed prices were recorded">Price not recorded</span>}
        </Fact>
      </dl>
      {order.completed_at && <p className="text-xs text-ix-muted">Completed {stamp(order.completed_at)}{order.history_expires_at ? ` · shown in Delivered History until ${stamp(order.history_expires_at)}` : ""}.</p>}

      <section aria-label="Products and quantities">
        <h3 className="mb-2 text-sm font-semibold text-ix-text">Products and quantities</h3>
        <div className="ix-inset overflow-x-auto">
          <table className={`w-full text-left text-sm ${order.currency_code && order.prices_recorded ? "min-w-[46rem]" : "min-w-[34rem]"}`}>
            <caption className="sr-only">Products on {order.number}</caption>
            <thead className="sticky top-0 bg-[rgb(var(--ix-field-rgb)/0.92)] text-[11px] uppercase tracking-wide text-ix-muted">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Ordered</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Dispatched</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Remaining</th>
                {order.prices_recorded && order.currency_code && <th scope="col" className="px-3 py-2.5 text-right font-medium">Price per piece</th>}
                {order.prices_recorded && order.currency_code && <th scope="col" className="px-3 py-2.5 text-right font-medium">Line total</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-ix-mist/10">
              {order.lines.map((l: OrderLine) => (
                <tr key={l.id}>
                  <td className="px-3 py-2.5"><div className="font-medium text-ix-text">{l.product_name}</div><div className="font-mono text-xs text-ix-accent-text">{l.product_sku}</div></td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">{qty(l.ordered_quantity)} <span className="text-ix-muted">{l.unit}</span></td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">{qty(l.dispatched_quantity)}{l.pending_quantity !== "0.0000" && l.pending_quantity !== "0" && <span className="block text-[11px] text-amber-200">+{qty(l.pending_quantity)} being posted</span>}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ix-text">{qty(l.remaining_quantity)}</td>
                  {order.prices_recorded && order.currency_code && <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">{l.unit_price ? formatMoney(l.unit_price, order.currency_code) : "—"}</td>}
                  {order.prices_recorded && order.currency_code && <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ix-text">{l.line_total ? formatMoney(l.line_total, order.currency_code) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {order.dispatches.length > 0 && (
        <section aria-label="Dispatches of this order">
          <h3 className="mb-2 text-sm font-semibold text-ix-text">Dispatches</h3>
          <ul className="flex flex-wrap gap-2">
            {order.dispatches.map((d) => (
              <li key={d.id}>
                <Link href={`/dispatches/${d.id}`} className="inline-flex items-center gap-2 rounded-full border border-ix-mist/15 bg-ix-mist/5 px-3 py-1 text-xs text-ix-mist transition-colors hover:border-ix-accent-text/30 hover:text-ix-accent-text">
                  <span className="font-mono">{d.number}</span><span className="text-ix-muted">{d.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// =====================================================================================================================================
// EDIT ORDER
// =====================================================================================================================================
function rowsOf(order: OrderDetail): OrderRow[] {
  return order.lines.map((l) => {
    const free = l.stock?.available_quantity ?? "0";
    return {
      productId: l.product_id, sku: l.product_sku, name: l.product_name, unit: l.unit, fractions: l.unit_allows_fractions ?? false,
      quantity: qty(l.ordered_quantity).replace(/,/g, ""), onHand: l.stock?.total_quantity ?? "0", reserved: l.stock?.reserved_quantity ?? "0",
      available: free, max: addDecimal(l.ordered_quantity, free), min: l.dispatched_quantity === "0.0000" ? "0" : l.dispatched_quantity,
      // the line's saved agreed price (frozen once any of it was dispatched); a product added in this dialog starts with none and MUST be given one
      unitPrice: l.unit_price ? plainDecimal(l.unit_price) : "", priceLocked: l.dispatched_quantity !== "0.0000" && l.dispatched_quantity !== "0",
    };
  });
}

export function EditOrderModal({ orderId, onClose, onSaved }: { orderId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const { loading, order, error } = useOrder(orderId);
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const initial = useMemo(() => (order ? rowsOf(order) : null), [order]);
  const current = rows ?? initial;
  const errors = touched && current ? rowErrors(current) : {};
  // An order made before prices were recorded has no currency: nothing about prices is shown or sent for it. Otherwise every line must have its agreed price.
  const currency = order?.currency_code && order.prices_recorded !== false ? order.currency_code : null;
  const priceProblems = touched && current && currency ? rowPriceErrors(current) : {};
  const total = current && currency ? orderTotal(current) : null;

  async function save() {
    if (!order || !current || busy) return;
    setTouched(true);
    setProblem(null);
    if (current.length === 0) return setProblem("An order needs at least one product.");
    if (Object.keys(rowErrors(current)).length > 0) return setProblem("Please correct the highlighted quantities.");
    if (currency && Object.keys(rowPriceErrors(current)).length > 0) return setProblem("Enter a valid price per piece for every product (a product you added needs its agreed price).");
    setBusy(true);
    const r = await api(`/api/sales/orders/${order.id}`, { method: "PATCH", ...jsonBody({ version: order.version, lines: orderLines(current, currency !== null) }) });
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    if (r.data?.pending) return setProblem("The change was saved but the Inventory Service has not confirmed the new booking yet. Nothing is changed until it does; reopen the order to retry.");
    onSaved(`${order.number} was updated. Its reservation and delivery list follow the new quantities.`);
  }

  return (
    <Modal
      title={order ? `Edit ${order.number}` : "Edit order"}
      subtitle={order ? `${order.client.name} · ${order.delivery_list.number}` : undefined}
      onClose={onClose}
      dismissable={!busy}
      size="xl"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={buttonClass.secondary}>Cancel</button>
          <button type="button" onClick={save} disabled={busy || !order || !order.can_edit} className={buttonClass.primary}>{busy ? "Saving…" : "Save changes"}</button>
        </>
      }
    >
      {loading && <div role="status" aria-label="Loading the order" className="space-y-3"><div className="ix-skeleton h-12" /><div className="ix-skeleton h-40" /></div>}
      {error && <p role="alert" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{error}</p>}
      {order && current && (
        <div className="space-y-4">
          {!order.can_edit && <p role="note" className="rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">{order.edit_blocked_reason ?? "This order cannot be edited right now."}</p>}
          {problem && <p role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{problem}</p>}
          <p className="text-xs text-ix-muted">
            Lowering a quantity releases the difference at once; raising it books the extra units only if they are available. Goods that were already dispatched are never changed:
            a line cannot go below what was dispatched, and cannot be removed.
          </p>
          {currency && <p className="text-xs text-ix-muted">Prices are in {currency}. A line keeps the price agreed when the order was made (changing it is only possible before any of it is dispatched); a product you add needs its own agreed price.</p>}
          <OrderLinesEditor rows={current} onChange={setRows} errors={errors} disabled={busy || !order.can_edit} currency={currency} priceErrors={priceProblems} />
          {currency && <p className="text-right text-sm text-ix-muted">Order total <span className="ml-2 text-lg font-semibold tabular-nums text-ix-text" data-testid="edit-order-total">{total ? formatMoney(total, currency) : "—"}</span></p>}
        </div>
      )}
    </Modal>
  );
}
