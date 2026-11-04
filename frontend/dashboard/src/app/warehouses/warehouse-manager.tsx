"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { PagedResult, WarehouseFilters } from "@/lib/inventory";
import {
  EMPTY_WAREHOUSE,
  Warehouse,
  WarehouseFieldErrors,
  WarehouseFormValues,
  normalizeWarehouse,
  toWarehouseBody,
  validateWarehouse,
  warehouseToForm,
} from "@/lib/stock-validation";

type Panel = { mode: "add" } | { mode: "edit"; warehouse: Warehouse } | null;

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1 disabled:opacity-60";
const fieldBorder = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

export default function WarehouseManager({ list, filters }: { list: PagedResult<Warehouse>; filters: WarehouseFilters }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function navigate(next: Partial<WarehouseFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/warehouses?${query}` : "/warehouses"));
  }

  function done(text: string) {
    setPanel(null);
    setMessage({ ok: true, text });
    startTransition(() => router.refresh());
  }

  async function change(warehouse: Warehouse, action: "archive" | "restore") {
    setBusyId(warehouse.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error ?? "That did not work. Please try again." });
        return;
      }
      setConfirmingId(null);
      done(
        action === "archive"
          ? `${warehouse.code} was archived. Its stock and history are kept; show "Archived" warehouses to restore it.`
          : `${warehouse.code} was restored.`
      );
    } catch {
      setMessage({ ok: false, text: "Unable to reach the server. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  const filtered = Boolean(filters.q || filters.status !== "active");
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Warehouses</h2>
          <p className="text-xs text-slate-400">The locations where your organization keeps stock. Only your own warehouses are shown.</p>
        </div>
        <button
          type="button"
          onClick={() => { setMessage(null); setPanel(panel?.mode === "add" ? null : { mode: "add" }); }}
          aria-expanded={panel?.mode === "add"}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
        >
          {panel?.mode === "add" ? "Close" : "Add Warehouse"}
        </button>
      </div>

      {message && (
        <div
          role={message.ok ? "status" : "alert"}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${
            message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"
          }`}
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {panel && (
        <WarehouseForm
          key={panel.mode === "edit" ? panel.warehouse.id : "add"}
          warehouse={panel.mode === "edit" ? panel.warehouse : undefined}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[16rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Code, name or address"
                maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <button type="submit" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select
              value={filters.status}
              onChange={(e) => navigate({ status: e.target.value as WarehouseFilters["status"] })}
              className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          {filtered && (
            <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "active" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">
              Clear filters
            </button>
          )}
        </div>

        <div aria-busy={isPending} className={`transition-opacity ${isPending ? "opacity-50" : "opacity-100"}`}>
          {isPending && <p role="status" className="mb-2 text-xs text-slate-400">Updating…</p>}

          {!list.ok ? (
            <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${list.reason === "forbidden" ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-950/50 text-slate-300"}`}>
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so warehouses cannot be used. Please contact your platform administrator."
                : "Warehouses are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No warehouses match these filters." : "No warehouses yet. Use Add Warehouse to create your first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Warehouse</th>
                    <th className="px-4 py-3 font-semibold">Address</th>
                    <th className="px-4 py-3 font-semibold text-right">Products in stock</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((warehouse) => (
                    <tr key={warehouse.id} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{warehouse.name}</div>
                        <div className="font-mono text-xs text-indigo-300">{warehouse.code}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">{warehouse.address ?? <span className="text-slate-600">—</span>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{warehouse.products_in_stock}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          warehouse.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"
                        }`}>
                          {warehouse.is_active ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {confirmingId === warehouse.id ? (
                          <div className="space-y-2">
                            <p className="max-w-xs text-xs text-slate-300">
                              Archive {warehouse.code}?{" "}
                              {warehouse.products_in_stock > 0
                                ? `It still holds stock of ${warehouse.products_in_stock} product${warehouse.products_in_stock === 1 ? "" : "s"}. The stock and history are kept, but no stock can be added, removed or transferred until you restore it.`
                                : "Its history is kept and you can restore it any time."}
                            </p>
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={busyId === warehouse.id} onClick={() => change(warehouse, "archive")} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">
                                {busyId === warehouse.id ? "Archiving…" : "Yes, archive"}
                              </button>
                              <button type="button" onClick={() => setConfirmingId(null)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-1.5">
                            <button type="button" onClick={() => { setMessage(null); setPanel({ mode: "edit", warehouse }); }} aria-label={`Edit ${warehouse.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">
                              Edit
                            </button>
                            {warehouse.is_active ? (
                              <button type="button" onClick={() => setConfirmingId(warehouse.id)} aria-label={`Archive ${warehouse.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-slate-800">
                                Archive
                              </button>
                            ) : (
                              <button type="button" disabled={busyId === warehouse.id} onClick={() => change(warehouse, "restore")} aria-label={`Restore ${warehouse.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-slate-800 disabled:opacity-60">
                                {busyId === warehouse.id ? "Restoring…" : "Restore"}
                              </button>
                            )}
                          </div>
                        )}
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

function WarehouseForm({ warehouse, onDone, onCancel }: { warehouse?: Warehouse; onDone: (message: string) => void; onCancel: () => void }) {
  const router = useRouter();
  const editing = Boolean(warehouse);
  const [values, setValues] = useState<WarehouseFormValues>(warehouse ? warehouseToForm(warehouse) : EMPTY_WAREHOUSE);
  const [errors, setErrors] = useState<WarehouseFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update(field: keyof WarehouseFormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    const normalized = normalizeWarehouse(values);
    const found = validateWarehouse(normalized);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      const res = await fetch(editing ? `/api/warehouses/${warehouse!.id}` : "/api/warehouses", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? toWarehouseBody(normalized) : { code: normalized.code, name: normalized.name, address: normalized.address }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        if (data?.fieldErrors) setErrors(data.fieldErrors);
        setFormError(data?.error ?? "That did not work. Please try again.");
        return;
      }
      onDone(editing ? `${data.warehouse.code} was updated.` : `${data.warehouse.code} was created.`);
    } catch {
      setFormError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label={editing ? "Edit warehouse" : "Add warehouse"} className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-5">
      <h3 className="text-sm font-semibold text-white">{editing ? `Edit ${warehouse!.code}` : "New warehouse"}</h3>
      {formError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</div>}
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-xs font-medium text-slate-400">
          Code
          <input
            value={values.code}
            onChange={(e) => update("code", e.target.value)}
            maxLength={32}
            placeholder="MAIN"
            aria-invalid={Boolean(errors.code)}
            className={`${inputClass} font-mono uppercase ${fieldBorder(errors.code)}`}
          />
          {errors.code && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.code}</span>}
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">
          Name
          <input
            value={values.name}
            onChange={(e) => update("name", e.target.value)}
            maxLength={255}
            placeholder="Main warehouse"
            aria-invalid={Boolean(errors.name)}
            className={`${inputClass} ${fieldBorder(errors.name)}`}
          />
          {errors.name && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.name}</span>}
        </label>
      </div>
      <label className="block text-xs font-medium text-slate-400">
        Address <span className="text-slate-600">(optional)</span>
        <input
          value={values.address}
          onChange={(e) => update("address", e.target.value)}
          maxLength={500}
          aria-invalid={Boolean(errors.address)}
          className={`${inputClass} ${fieldBorder(errors.address)}`}
        />
        {errors.address && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.address}</span>}
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={loading} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {loading ? "Saving…" : editing ? "Save changes" : "Create warehouse"}
        </button>
      </div>
    </form>
  );
}
