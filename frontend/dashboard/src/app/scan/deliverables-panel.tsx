"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import AddItemForm from "@/components/add-item-form";
import type { Product } from "@/lib/product-validation";
import { api, jsonBody } from "@/lib/sales-browser";
import type { Client, DeliveryListSummary } from "@/lib/sales";
import type { StockProduct } from "@/lib/stock-validation";

export type ActiveList = { id: string; number: string; clientName: string; itemCount: number };

type Props = {
  product: Product;
  stock: StockProduct;
  activeListId: string | null;
  onActiveList: (list: ActiveList) => void;
  onAdded: (message: string) => void;
  onClose: () => void;
};

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const NEW = "__new__";

// "Add to Deliverables": pick one of your draft delivery lists (or start a new one for a client), type the quantity the
// client needs, add. The scanned product is the item; its name, SKU, unit and stock are re-read by the Sales Service from
// the Inventory Service. Nothing here deducts or reserves stock, and a repeated scan never adds quantity by itself.
export default function DeliverablesPanel({ product, stock, activeListId, onActiveList, onAdded, onClose }: Props) {
  const [drafts, setDrafts] = useState<DeliveryListSummary[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [clientId, setClientId] = useState("");
  const [newClient, setNewClient] = useState("");
  const [reference, setReference] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function loadDrafts(select?: string) {
    const r = await api<{ items: DeliveryListSummary[] }>("/api/sales/delivery-lists?status=draft&limit=100");
    if (!r.ok) return setLoadError(r.error);
    const items = r.data?.items ?? [];
    setDrafts(items);
    setChoice((current) => select ?? (current || (activeListId && items.some((l) => l.id === activeListId) ? activeListId : items.length === 0 ? NEW : "")));
  }

  useEffect(() => {
    void loadDrafts();
    void api<{ items: Client[] }>("/api/sales/clients?status=active&limit=200").then((r) => r.ok && setClients(r.data?.items ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createList(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating) return;
    setCreateError(null);
    if (!clientId && !newClient.trim()) return setCreateError("Choose the client this list is for, or enter a new client's name.");
    setCreating(true);
    let id = clientId;
    if (!id) {
      const made = await api("/api/sales/clients", { method: "POST", ...jsonBody({ name: newClient }) });
      if (!made.ok) { setCreating(false); return setCreateError(made.error); }
      id = made.data.client.id;
      setClients((c) => [...c, made.data.client]);
      setClientId(id);
      setNewClient("");
    }
    const r = await api("/api/sales/delivery-lists", { method: "POST", ...jsonBody({ clientId: id, externalReference: reference }) });
    setCreating(false);
    if (!r.ok) return setCreateError(r.error);
    const created: DeliveryListSummary = r.data.list;
    await loadDrafts(created.id);
    onActiveList({ id: created.id, number: created.number, clientName: created.client.name, itemCount: 0 });
    setReference("");
  }

  const selected = drafts?.find((l) => l.id === choice) ?? null;

  return (
    <section aria-label="Add to Deliverables" className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-white">Add to Deliverables</h4>
          <p className="text-xs text-slate-400">Put this product on a client&apos;s delivery list. It does not remove any stock.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {loadError && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{loadError}</p>}
      {!drafts && !loadError && <p role="status" className="text-sm text-slate-400">Loading your delivery lists…</p>}

      {drafts && (
        <label className="block text-xs font-medium text-slate-400">
          Delivery list
          <select value={choice} onChange={(e) => { setChoice(e.target.value); setCreateError(null); }} className={fieldClass}>
            <option value="">Choose a draft list…</option>
            {drafts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.number} · {l.client.name}{l.external_reference ? ` · ${l.external_reference}` : ""} · {l.item_count} {l.item_count === 1 ? "item" : "items"}
              </option>
            ))}
            <option value={NEW}>＋ Create a new delivery list…</option>
          </select>
        </label>
      )}

      {choice === NEW && (
        <form onSubmit={createList} noValidate aria-label="New delivery list" className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <label className="block text-xs font-medium text-slate-400">
            Client
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={fieldClass}>
              <option value="">{clients.length ? "Choose a client…" : "No clients yet"}</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-400">
            …or register a new client
            <input value={newClient} onChange={(e) => setNewClient(e.target.value)} disabled={Boolean(clientId)} maxLength={255} placeholder="New client's name" className={`${fieldClass} disabled:opacity-50`} />
          </label>
          <label className="block text-xs font-medium text-slate-400">
            Your order reference (optional)
            <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={fieldClass} />
          </label>
          {createError && <p role="alert" className="text-sm text-red-400">{createError}</p>}
          <button type="submit" disabled={creating} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-60">{creating ? "Creating…" : "Create list"}</button>
        </form>
      )}

      {selected && (
        <>
          <p className="text-xs text-slate-400">
            Adding to <Link href={`/delivery-lists/${selected.id}`} className="font-mono font-semibold text-indigo-300 hover:text-indigo-200">{selected.number}</Link> for {selected.client.name}.
          </p>
          <AddItemForm
            key={`${selected.id}-${product.id}`}
            listId={selected.id}
            listNumber={selected.number}
            product={product}
            stock={stock}
            onChanged={({ message, itemCount }) => {
              const count = itemCount ?? selected.item_count + 1;
              onActiveList({ id: selected.id, number: selected.number, clientName: selected.client.name, itemCount: count });
              setDrafts((all) => all && all.map((l) => (l.id === selected.id ? { ...l, item_count: count } : l)));
              onAdded(message);
            }}
          />
        </>
      )}
    </section>
  );
}
