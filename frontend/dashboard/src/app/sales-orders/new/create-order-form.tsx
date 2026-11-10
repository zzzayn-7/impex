"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import { GlassPanel } from "@/components/ui/glass";
import { PageHeader } from "@/components/ui/page";
import { CURRENCIES, currencyLabel } from "@/lib/currencies";
import { keyFor, orderLines, readyToSave, rowErrors, signatureOf, type OrderRow } from "@/lib/order-form";
import type { Client } from "@/lib/sales";
import { api, jsonBody } from "@/lib/sales-browser";
import ClientSelect from "./client-select";
import InventoryPicker from "./inventory-picker";
import OrderCheckout from "./order-checkout";

// CREATE ORDER, in two clearly separate steps: Select Client & Products -> Checkout -> Enter Unit Prices -> Save Order -> Delivery List.
//
//  Step 1  the client, the order's currency, and the products with their quantities (search the inventory or scan a product; Add / Drop each one). The only
//          buttons are Cancel and Checkout. Checkout creates nothing, reserves nothing and changes no stock: it only moves on to Step 2 (the unsaved selection
//          lives in this component, so going back and forth loses nothing).
//  Step 2  (OrderCheckout) the selection is read-only; the person types the price of ONE piece for every product, the price agreed with THIS client. Save Order
//          sends the client, the currency, every product with its quantity and agreed price, and books the stock immediately (all products, or none), generates
//          the order number and its linked delivery list, and opens Delivery Lists. Physical stock is not touched until goods are dispatched; a price has no
//          influence on any stock figure.
export default function CreateOrderForm({ clients: initialClients, defaultCurrency = "USD" }: { clients: Client[]; defaultCurrency?: string }) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const [clientId, setClientId] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [step, setStep] = useState<"select" | "checkout">("select");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const chosen = clients.find((c) => c.id === clientId) ?? null;
  // A quantity that is typed and wrong is pointed at straight away; an empty one only after Checkout was tried.
  const errors = Object.fromEntries(Object.entries(rowErrors(rows)).filter(([id]) => touched || (rows.find((r) => r.productId === id)?.quantity.trim() ?? "") !== ""));
  const quantitiesOk = rows.length > 0 && Object.keys(rowErrors(rows)).length === 0;
  const canCheckout = Boolean(clientId) && quantitiesOk;
  const changeRows = (next: OrderRow[]) => { setRows(next); setPending(null); setError(null); };
  const setPrice = (productId: string, value: string) => { setRows((current) => current.map((r) => (r.productId === productId ? { ...r, unitPrice: value } : r))); setPending(null); setError(null); };

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

  // Checkout: only moves to the pricing step. No request is made.
  function checkout() {
    setTouched(true);
    setError(null);
    if (!clientId) return setError("Choose the client, or register a new one.");
    if (rows.length === 0) return setError("Add at least one product.");
    if (!quantitiesOk) return setError("Please correct the highlighted quantities.");
    setStep("checkout");
    document.scrollingElement?.scrollTo?.({ top: 0 }); // the checkout starts at the top of the page
  }

  function backToProducts() {
    if (busy) return;
    setStep("select");
    setPending(null);
    setError(null);
  }

  async function save() {
    if (busy) return;
    setError(null);
    if (!readyToSave(clientId, rows)) return setError("Enter a valid price for every product first.");
    attempt.current = keyFor(signatureOf(clientId, rows, currency), attempt.current);
    setBusy(true);
    const r = await api("/api/sales/orders", { method: "POST", headers: { "Idempotency-Key": attempt.current.key }, ...jsonBody({ clientId, currencyCode: currency, lines: orderLines(rows) }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (r.status === 202) return setPending(r.data?.order?.number ?? "Your order");
    if (!r.ok) return setError(r.error);
    router.push(`/delivery-lists?created=${encodeURIComponent(r.data.order.number)}`);
  }

  const banners = (
    <>
      {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
      {pending && (
        <div role="status" className="space-y-2 rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">
          <p><strong>{pending}</strong> was saved, but the Inventory Service has not confirmed the stock booking yet, so nothing is treated as booked. Retrying cannot book the stock twice.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setPending(null); void save(); }} className={buttonClass.secondary}>Retry booking</button>
            <Link href="/delivery-lists" className={buttonClass.secondary}>Go to Delivery Lists</Link>
          </div>
        </div>
      )}
    </>
  );

  if (step === "checkout") {
    return (
      <div className="space-y-5">
        <PageHeader title="Order Checkout" subtitle="Review your selected products and enter the selling price for each item." />
        {banners}
        <OrderCheckout clientName={chosen?.name ?? ""} clientId={clientId} currency={currency} rows={rows} onPrice={setPrice} onBack={backToProducts} onSave={save} busy={busy} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Create Order" subtitle="Choose the client, then add the products they need from your inventory. Checkout comes next: you enter the price agreed with this client there." />
      <form onSubmit={(e) => { e.preventDefault(); checkout(); }} noValidate aria-label="Create order" className="space-y-5">
        {banners}

        <GlassPanel className="space-y-6 p-5 sm:p-6">
          <section className="space-y-4" aria-labelledby="client-heading">
            <h3 id="client-heading" className="text-[15px] font-semibold text-ix-text">Client</h3>
            <ClientSelect clients={clients} value={clientId} onSelect={setClientId} onRegister={registerClient} disabled={busy} />
            <div className="max-w-xs">
              <label htmlFor="order-currency" className="block text-xs font-medium text-ix-muted">Order currency</label>
              <select id="order-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={fieldClass}>
                {!CURRENCIES.some(([code]) => code === currency) && <option value={currency}>{currency}</option>}
                {CURRENCIES.map(([code]) => <option key={code} value={code}>{currencyLabel(code)}</option>)}
              </select>
              <p className="mt-1.5 text-xs text-ix-muted">The prices of this order are in one currency; nothing is converted. It starts from your organization&apos;s default currency.</p>
            </div>
          </section>

          <section className="space-y-4 border-t border-ix-mist/10 pt-6" aria-labelledby="products-heading">
            <h3 id="products-heading" className="text-[15px] font-semibold text-ix-text">Products required</h3>
            <InventoryPicker rows={rows} onChange={changeRows} errors={errors} disabled={busy} locked={!clientId} />
          </section>
        </GlassPanel>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/delivery-lists" className={buttonClass.secondary}>Cancel</Link>
          <button type="submit" disabled={busy || !canCheckout} className={buttonClass.primary}>Checkout</button>
        </div>
      </form>
    </div>
  );
}
