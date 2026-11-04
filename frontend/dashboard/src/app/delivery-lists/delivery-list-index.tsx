"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { STATUS_LABELS, STATUS_STYLE, api, jsonBody } from "@/lib/sales-browser";
import type { Client, DeliveryListSummary, ListFilters, ListStatus, Paged } from "@/lib/sales";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

export default function DeliveryListIndex({ list, filters, clients }: { list: Paged<DeliveryListSummary>; filters: ListFilters; clients: Client[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<ListFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.clientId) params.set("client", merged.clientId);
    if (merged.status) params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/delivery-lists?${query}` : "/delivery-lists"));
  }

  const filtered = Boolean(filters.q || filters.clientId || filters.status);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const activeClients = clients.filter((c) => c.is_active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Delivery Lists</h2>
          <p className="text-xs text-slate-400">Products promised to your clients, waiting for delivery. A list never changes your stock.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/scan" className="inline-flex min-h-11 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Scan products</Link>
          <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">
            {creating ? "Close" : "New Delivery List"}
          </button>
        </div>
      </div>

      {creating && <NewListForm clients={activeClients} defaultClientId={filters.clientId} onCancel={() => setCreating(false)} />}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="List number, reference or client" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Client
            <select value={filters.clientId} onChange={(e) => navigate({ clientId: e.target.value })} className="mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (inactive)"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as ListFilters["status"] })} className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABELS) as ListStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", clientId: "", status: "" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so delivery lists cannot be used. Please contact your platform administrator." : "Delivery lists are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No delivery lists match these filters." : "No delivery lists yet. Use New Delivery List, or scan a product and choose Add to Deliverables."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">List</th><th className="px-4 py-3 font-semibold">Client</th><th className="px-4 py-3 font-semibold">Reference</th>
                    <th className="px-4 py-3 font-semibold text-right">Items</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3"><Link href={`/delivery-lists/${item.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{item.number}</Link></td>
                      <td className="px-4 py-3">{item.client.name}{!item.client.is_active && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}</td>
                      <td className="px-4 py-3 text-xs">{item.external_reference ?? <span className="text-slate-600">—</span>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{item.item_count}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[item.status]}`}>{STATUS_LABELS[item.status]}</span></td>
                      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{item.updated_at.slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {list.ok && total > 0 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Showing {first}–{last} of {total}</span>
            <div className="flex gap-2">
              <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
              <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function NewListForm({ clients, defaultClientId, onCancel }: { clients: Client[]; defaultClientId: string; onCancel: () => void }) {
  const router = useRouter();
  const [clientId, setClientId] = useState(clients.some((c) => c.id === defaultClientId) ? defaultClientId : "");
  const [newClient, setNewClient] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!clientId && !newClient.trim()) return setError("Choose a client, or enter the name of a new one.");
    setBusy(true);
    let id = clientId;
    if (!id) {
      const created = await api("/api/sales/clients", { method: "POST", ...jsonBody({ name: newClient }) });
      if (!created.ok) { setBusy(false); return setError(created.error); }
      id = created.data.client.id;
      setClientId(id);
    }
    const r = await api("/api/sales/delivery-lists", { method: "POST", ...jsonBody({ clientId: id, externalReference: reference, notes }) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    router.push(`/delivery-lists/${r.data.list.id}`);
  }

  return (
    <form onSubmit={submit} noValidate aria-label="New delivery list" className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-white">New delivery list</h3>
      {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-400">
          Client
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={fieldClass}>
            <option value="">{clients.length ? "Choose a client…" : "No clients yet"}</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-400">
          …or register a new client
          <input value={newClient} onChange={(e) => setNewClient(e.target.value)} disabled={Boolean(clientId)} maxLength={255} placeholder="New client's name" className={`${fieldClass} disabled:opacity-50`} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Your order reference (optional)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Delivery notes (optional)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={fieldClass} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Creating…" : "Create list"}</button>
      </div>
    </form>
  );
}
