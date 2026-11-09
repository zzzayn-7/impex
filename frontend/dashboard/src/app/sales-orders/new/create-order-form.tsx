"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";

import OrderLinesEditor from "@/components/sales/order-lines-editor";
import { buttonClass } from "@/components/ui/controls";
import { GlassPanel } from "@/components/ui/glass";
import { Modal } from "@/components/ui/modal";
import { keyFor, orderLines, rowErrors, signatureOf, type OrderRow } from "@/lib/order-form";
import type { Client } from "@/lib/sales";
import { api, jsonBody } from "@/lib/sales-browser";
import ClientSelect from "./client-select";
import InventoryPicker from "./inventory-picker";

// CREATE ORDER: ONE form. The client at the top, then the inventory list (search it or scan a product, Add / Drop each one), and "View List" to
// review the chosen products in a dialog. The client's name and the products required are all that is saved. Saving books the stock immediately (all products, or none), generates the order
// number and its linked delivery list, and opens the Delivery Lists overview. Physical stock is not touched until goods are dispatched.
export default function CreateOrderForm({ clients: initialClients }: { clients: Client[] }) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [clientId, setClientId] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const chosen = clients.find((c) => c.id === clientId) ?? null;
  const errors = touched ? rowErrors(rows) : {};
  const changeRows = (next: OrderRow[]) => { setRows(next); setPending(null); setError(null); };

  async function registerClient(name: string) {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const r = await api("/api/sales/clients", { method: "POST", ...jsonBody({ name }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    const created = r.data.client as Client;
    setClients((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
    setClientId(created.id);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setTouched(true);
    setError(null);
    if (!clientId) return setError("Choose the client, or register a new one.");
    if (rows.length === 0) return setError("Add at least one product.");
    if (Object.keys(rowErrors(rows)).length > 0) return setError("Please correct the highlighted quantities.");

    attempt.current = keyFor(signatureOf(clientId, rows), attempt.current);
    setBusy(true);
    const r = await api("/api/sales/orders", { method: "POST", headers: { "Idempotency-Key": attempt.current.key }, ...jsonBody({ clientId, lines: orderLines(rows) }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (r.status === 202) return setPending(r.data?.order?.number ?? "Your order");
    if (!r.ok) return setError(r.error);
    router.push(`/delivery-lists?created=${encodeURIComponent(r.data.order.number)}`);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Create order" className="space-y-5">
      {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {pending && (
        <div role="status" className="space-y-2 rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">
          <p><strong>{pending}</strong> was saved, but the Inventory Service has not confirmed the stock booking yet, so nothing is treated as booked. Retrying cannot book the stock twice.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setPending(null); void submit(); }} className={buttonClass.secondary}>Retry booking</button>
            <Link href="/delivery-lists" className={buttonClass.secondary}>Go to Delivery Lists</Link>
          </div>
        </div>
      )}

      <GlassPanel className="space-y-6 p-5 sm:p-6">
        <section className="space-y-4" aria-labelledby="client-heading">
          <h3 id="client-heading" className="text-[15px] font-semibold text-ix-text">Client</h3>
          <ClientSelect clients={clients} value={clientId} onSelect={setClientId} onRegister={registerClient} disabled={busy} />
        </section>

        <section className="space-y-4 border-t border-ix-mist/10 pt-6" aria-labelledby="products-heading">
          <h3 id="products-heading" className="text-[15px] font-semibold text-ix-text">Products required</h3>
          <InventoryPicker rows={rows} onChange={changeRows} errors={errors} disabled={busy} locked={!clientId} />
        </section>
      </GlassPanel>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link href="/delivery-lists" className={buttonClass.secondary}>Cancel</Link>
        <button type="button" onClick={() => setListOpen(true)} className={buttonClass.secondary}>
          View List
          <span className="rounded-full bg-ix-butter/20 px-2 py-0.5 text-xs font-semibold tabular-nums text-ix-accent-text">{rows.length}</span>
        </button>
        <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? "Saving…" : "Save Order"}</button>
      </div>

      {listOpen && typeof document !== "undefined" && createPortal(
        <Modal
          title="Selected products"
          subtitle={rows.length === 0 ? "Nothing selected yet" : `${rows.length} ${rows.length === 1 ? "product" : "products"} on this order${chosen ? ` for ${chosen.name}` : ""}`}
          onClose={() => setListOpen(false)}
          size="xl"
          footer={<button type="button" onClick={() => setListOpen(false)} className={buttonClass.primary}>Done</button>}
        >
          <OrderLinesEditor rows={rows} onChange={changeRows} errors={errors} disabled={busy} showPicker={false} emptyMessage="No products selected yet. Use Add in the inventory list." />
        </Modal>,
        document.body,
      )}
    </form>
  );
}
