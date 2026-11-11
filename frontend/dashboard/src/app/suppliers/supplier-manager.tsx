"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import type { Paged, Supplier, SupplierFilters } from "@/lib/purchasing";

type Panel = { mode: "add" } | { mode: "edit"; supplier: Supplier } | null;

const inputClass = "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1";
const border = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

export default function SupplierManager({ list, filters }: { list: Paged<Supplier>; filters: SupplierFilters }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [details, setDetails] = useState<Supplier | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [busyId, setBusyId] = useState<string | null>(null);

  function navigate(next: Partial<SupplierFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/suppliers?${query}` : "/suppliers"));
  }

  function done(text: string) {
    setPanel(null);
    setDetails(null);
    setMessage({ ok: true, text });
    startTransition(() => router.refresh());
  }

  async function toggle(supplier: Supplier) {
    setBusyId(supplier.id);
    setMessage(null);
    const r = await api(`/api/purchasing/suppliers/${supplier.id}/${supplier.is_active ? "deactivate" : "activate"}`, { method: "POST" });
    setBusyId(null);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    done(supplier.is_active ? `${supplier.name} was deactivated. Its orders are kept; it gets no new ones until reactivated.` : `${supplier.name} was reactivated.`);
  }

  const filtered = Boolean(filters.q || filters.status !== "active");
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Suppliers</h2>
          <p className="text-xs text-slate-400">The companies you buy from. Only your own suppliers are shown.</p>
        </div>
        <button type="button" onClick={() => { setMessage(null); setDetails(null); setPanel(panel?.mode === "add" ? null : { mode: "add" }); }} aria-expanded={panel?.mode === "add"}
          className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">
          {panel?.mode === "add" ? "Close" : "Add Supplier"}
        </button>
      </div>

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {panel && <SupplierForm key={panel.mode === "edit" ? panel.supplier.id : "add"} supplier={panel.mode === "edit" ? panel.supplier : undefined} onDone={done} onCancel={() => setPanel(null)} />}

      {details && (
        <section aria-label="Supplier details" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">{details.name} {details.code && <span className="ml-1 font-mono text-sm text-indigo-300">{details.code}</span>}</h3>
              <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${details.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>{details.is_active ? "Active" : "Inactive"}</span>
            </div>
            <div className="flex gap-2">
              <Link href={`/purchase-orders?supplier=${details.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Purchase orders</Link>
              <button type="button" onClick={() => setDetails(null)} aria-label="Close details" className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Close</button>
            </div>
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {([["Contact person", details.contact_person], ["E-mail", details.email], ["Phone", details.phone], ["Country", details.country_code], ["Tax identifier", details.tax_identifier], ["Address", details.address]] as const).map(([label, value]) => (
              <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="text-slate-200">{value ?? <span className="text-slate-600">—</span>}</dd></div>
            ))}
            <div><dt className="text-xs text-slate-500">Registered</dt><dd className="text-slate-200">{details.created_at.slice(0, 10)}</dd></div>
          </dl>
        </section>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, contact, e-mail, phone or tax id" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as SupplierFilters["status"] })} className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so suppliers cannot be used. Please contact your platform administrator." : "Suppliers are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No suppliers match these filters." : "No suppliers yet. Use Add Supplier to register your first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr><th className="px-4 py-3 font-semibold">Supplier</th><th className="px-4 py-3 font-semibold">Contact</th><th className="px-4 py-3 font-semibold">Country</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">Actions</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((supplier) => (
                    <tr key={supplier.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => { setPanel(null); setDetails(supplier); }} aria-label={`Details of ${supplier.name}`} className="text-left font-medium text-white hover:text-indigo-200">{supplier.name}</button>
                        {supplier.code && <div className="font-mono text-xs text-indigo-300">{supplier.code}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {[supplier.contact_person, supplier.email, supplier.phone].filter(Boolean).map((v, i) => <div key={i}>{v}</div>)}
                        {!supplier.contact_person && !supplier.email && !supplier.phone && <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs">{supplier.country_code ?? <span className="text-slate-600">—</span>}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${supplier.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>{supplier.is_active ? "Active" : "Inactive"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <button type="button" onClick={() => { setMessage(null); setDetails(null); setPanel({ mode: "edit", supplier }); }} aria-label={`Edit ${supplier.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Edit</button>
                          <button type="button" disabled={busyId === supplier.id} onClick={() => toggle(supplier)} aria-label={`${supplier.is_active ? "Deactivate" : "Reactivate"} ${supplier.name}`}
                            className={`rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-800 disabled:opacity-60 ${supplier.is_active ? "text-red-300" : "text-emerald-300"}`}>
                            {supplier.is_active ? "Deactivate" : "Reactivate"}
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

function SupplierForm({ supplier, onDone, onCancel }: { supplier?: Supplier; onDone: (message: string) => void; onCancel: () => void }) {
  const router = useRouter();
  const editing = Boolean(supplier);
  const [values, setValues] = useState({
    name: supplier?.name ?? "", code: supplier?.code ?? "", contactPerson: supplier?.contact_person ?? "", email: supplier?.email ?? "", phone: supplier?.phone ?? "",
    address: supplier?.address ?? "", countryCode: supplier?.country_code ?? "", taxIdentifier: supplier?.tax_identifier ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (field: keyof typeof values, value: string) => { setValues((v) => ({ ...v, [field]: value })); setErrors((e) => ({ ...e, [field]: "" })); };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    if (!values.name.trim()) return setErrors({ name: "Enter the supplier's name." });
    setLoading(true);
    const r = await api(editing ? `/api/purchasing/suppliers/${supplier!.id}` : "/api/purchasing/suppliers", { method: editing ? "PATCH" : "POST", ...jsonBody(values) });
    setLoading(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    onDone(editing ? `${r.data.supplier.name} was updated.` : `${r.data.supplier.name} was registered.`);
  }

  const field = (id: keyof typeof values, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="text-xs font-medium text-slate-400">
      {label}
      <input value={values[id]} onChange={(e) => set(id, e.target.value)} aria-invalid={Boolean(errors[id])} className={`${inputClass} ${border(errors[id])}`} {...props} />
      {errors[id] && <span role="alert" className="mt-1 block text-xs text-red-400">{errors[id]}</span>}
    </label>
  );

  return (
    <form onSubmit={onSubmit} noValidate aria-label={editing ? "Edit supplier" : "Add supplier"} className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-white">{editing ? `Edit ${supplier!.name}` : "New supplier"}</h3>
      {formError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</div>}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">{field("name", "Supplier / company name", { maxLength: 255, placeholder: "Acme Supplies GmbH" })}</div>
        {field("code", "Supplier code (optional)", { maxLength: 32, placeholder: "ACME", style: { textTransform: "uppercase" } })}
        {field("contactPerson", "Contact person (optional)", { maxLength: 255 })}
        {field("email", "E-mail (optional)", { type: "email", maxLength: 320 })}
        {field("phone", "Phone (optional)", { type: "tel", maxLength: 50 })}
        {field("countryCode", "Country code (optional)", { maxLength: 2, placeholder: "DE", style: { textTransform: "uppercase" } })}
        {field("taxIdentifier", "Tax identifier (optional)", { maxLength: 50 })}
      </div>
      {field("address", "Address (optional)", { maxLength: 500 })}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={loading} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{loading ? "Saving…" : editing ? "Save changes" : "Register supplier"}</button>
      </div>
    </form>
  );
}
