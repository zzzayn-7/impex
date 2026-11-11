"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import type { Client, ClientFilters, Paged } from "@/lib/sales";

type Panel = { mode: "add" } | { mode: "edit"; client: Client } | null;

const inputClass = "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1";
const border = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

export default function ClientManager({ list, filters }: { list: Paged<Client>; filters: ClientFilters }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [busyId, setBusyId] = useState<string | null>(null);

  function navigate(next: Partial<ClientFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/clients?${query}` : "/clients"));
  }

  function done(text: string) {
    setPanel(null);
    setMessage({ ok: true, text });
    startTransition(() => router.refresh());
  }

  async function toggle(client: Client) {
    setBusyId(client.id);
    setMessage(null);
    const action = client.is_active ? "deactivate" : "activate";
    const r = await api(`/api/sales/clients/${client.id}/${action}`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    done(client.is_active ? `${client.name} was deactivated. Its delivery lists are kept; it gets no new ones until reactivated.` : `${client.name} was reactivated.`);
  }

  const filtered = Boolean(filters.q || filters.status !== "active");
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Clients</h2>
          <p className="text-xs text-slate-400">The companies you deliver to. Only your own clients are shown.</p>
        </div>
        <button type="button" onClick={() => { setMessage(null); setPanel(panel?.mode === "add" ? null : { mode: "add" }); }} aria-expanded={panel?.mode === "add"}
          className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">
          {panel?.mode === "add" ? "Close" : "Add Client"}
        </button>
      </div>

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {panel && <ClientForm key={panel.mode === "edit" ? panel.client.id : "add"} client={panel.mode === "edit" ? panel.client : undefined} onDone={done} onCancel={() => setPanel(null)} />}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, contact, e-mail or phone" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as ClientFilters["status"] })} className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so clients cannot be used. Please contact your platform administrator." : "Clients are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No clients match these filters." : "No clients yet. Use Add Client to register your first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr><th className="px-4 py-3 font-semibold">Client</th><th className="px-4 py-3 font-semibold">Contact</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">Actions</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((client) => (
                    <tr key={client.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{client.name}</div>
                        {client.address && <div className="text-xs text-slate-500">{client.address}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {[client.contact_person, client.email, client.phone].filter(Boolean).map((v, i) => <div key={i}>{v}</div>)}
                        {!client.contact_person && !client.email && !client.phone && <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${client.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>{client.is_active ? "Active" : "Inactive"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Link href={`/delivery-lists?client=${client.id}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Delivery lists</Link>
                          <Link href={`/clients/${client.id}`} aria-label={`Invoices and balance of ${client.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Invoices</Link>
                          <button type="button" onClick={() => { setMessage(null); setPanel({ mode: "edit", client }); }} aria-label={`Edit ${client.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Edit</button>
                          <button type="button" disabled={busyId === client.id} onClick={() => toggle(client)} aria-label={`${client.is_active ? "Deactivate" : "Reactivate"} ${client.name}`}
                            className={`rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-800 disabled:opacity-60 ${client.is_active ? "text-red-300" : "text-emerald-300"}`}>
                            {client.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                        </div>
                      </td>
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

function ClientForm({ client, onDone, onCancel }: { client?: Client; onDone: (message: string) => void; onCancel: () => void }) {
  const router = useRouter();
  const editing = Boolean(client);
  const [values, setValues] = useState({ name: client?.name ?? "", contactPerson: client?.contact_person ?? "", email: client?.email ?? "", phone: client?.phone ?? "", address: client?.address ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (field: keyof typeof values, value: string) => { setValues((v) => ({ ...v, [field]: value })); setErrors((e) => ({ ...e, [field]: "" })); };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    if (!values.name.trim()) return setErrors({ name: "Enter the client's name." });
    setLoading(true);
    const r = await api(editing ? `/api/sales/clients/${client!.id}` : "/api/sales/clients", { method: editing ? "PATCH" : "POST", ...jsonBody(values) });
    setLoading(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    onDone(editing ? `${r.data.client.name} was updated.` : `${r.data.client.name} was registered.`);
  }

  const field = (id: keyof typeof values, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="text-xs font-medium text-slate-400">
      {label}
      <input value={values[id]} onChange={(e) => set(id, e.target.value)} aria-invalid={Boolean(errors[id])} className={`${inputClass} ${border(errors[id])}`} {...props} />
      {errors[id] && <span role="alert" className="mt-1 block text-xs text-red-400">{errors[id]}</span>}
    </label>
  );

  return (
    <form onSubmit={onSubmit} noValidate aria-label={editing ? "Edit client" : "Add client"} className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-white">{editing ? `Edit ${client!.name}` : "New client"}</h3>
      {formError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Client / company name", { maxLength: 255, placeholder: "Acme Trading Ltd" })}
        {field("contactPerson", "Contact person (optional)", { maxLength: 255 })}
        {field("email", "E-mail (optional)", { type: "email", maxLength: 320 })}
        {field("phone", "Phone (optional)", { type: "tel", maxLength: 50 })}
      </div>
      {field("address", "Address (optional)", { maxLength: 500 })}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={loading} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{loading ? "Saving…" : editing ? "Save changes" : "Register client"}</button>
      </div>
    </form>
  );
}
