"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_SINGULAR, ACCOUNT_TYPES, api, jsonBody } from "@/lib/finance-browser";
import type { Account, AccountType } from "@/lib/finance";
import { dangerButton, fieldClass, InfoNotice, Pill, primaryButton, secondaryButton, selectClass } from "../ui";

type Draft = { code: string; name: string; accountType: AccountType; description: string };
const EMPTY: Draft = { code: "", name: "", accountType: "expense", description: "" };

/** The chart of accounts: Assets, Liabilities, Equity, Revenue and Expenses. System accounts (the ones Finance itself posts to) can be renamed but
 *  never deleted, deactivated or re-typed; an account with postings keeps its code and type; an unused account can be deleted. */
export default function AccountsManager({ initial }: { initial: Account[] }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(initial);
  const [type, setType] = useState<AccountType | "">("");
  const [state, setState] = useState<"" | "active" | "inactive">("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter((a) => (!type || a.account_type === type) && (!state || a.is_active === (state === "active")) && (!term || a.code.toLowerCase().includes(term) || a.name.toLowerCase().includes(term)));
  }, [accounts, type, state, search]);

  function failed(r: { status: number; error: string; fieldErrors?: Record<string, string> }) {
    if (r.status === 401) return router.replace("/login");
    setFieldErrors(r.fieldErrors ?? {});
    setError(r.error);
  }

  const replace = (account: Account) => setAccounts((all) => all.map((a) => (a.id === account.id ? account : a)));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    const r = await api("/api/finance/accounts", { method: "POST", ...jsonBody(draft) });
    setBusy(false);
    if (!r.ok) return failed(r);
    setAccounts((all) => [...all, r.data.account].sort((a, b) => a.code.localeCompare(b.code)));
    setDraft(EMPTY);
    setAdding(false);
    setNotice(`${r.data.account.code} ${r.data.account.name} was added.`);
  }

  async function save(account: Account) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/finance/accounts/${account.id}`, { method: "PATCH", ...jsonBody(edit) });
    setBusy(false);
    if (!r.ok) return failed(r);
    replace(r.data.account);
    setEditing(null);
    setNotice("Saved.");
  }

  async function setActive(account: Account, isActive: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/finance/accounts/${account.id}`, { method: "PATCH", ...jsonBody({ isActive }) });
    setBusy(false);
    if (!r.ok) return failed(r);
    replace(r.data.account);
    setNotice(`${account.code} ${account.name} is now ${isActive ? "active" : "inactive"}. ${isActive ? "" : "It keeps its history but can no longer be posted to."}`.trim());
  }

  async function remove(account: Account) {
    if (busy || !window.confirm(`Delete ${account.code} ${account.name}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/finance/accounts/${account.id}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return failed(r);
    setAccounts((all) => all.filter((a) => a.id !== account.id));
    setNotice(`${account.code} ${account.name} was deleted.`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Accounts</h2>
          <p className="text-xs text-slate-400">Your chart of accounts. Accounts marked <em>System</em> are the ones Finance posts to automatically.</p>
        </div>
        <button type="button" onClick={() => { setAdding((v) => !v); setError(null); setFieldErrors({}); }} className={primaryButton}>{adding ? "Cancel" : "New Account"}</button>
      </div>

      {adding && (
        <form onSubmit={add} aria-label="New account" className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-4 sm:p-5">
          <label className="text-xs font-medium text-slate-400">Code
            <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} maxLength={20} required className={fieldClass} aria-invalid={Boolean(fieldErrors.code)} />
            {fieldErrors.code && <span className="mt-1 block text-red-300">{fieldErrors.code}</span>}
          </label>
          <label className="text-xs font-medium text-slate-400 sm:col-span-2">Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={150} required className={fieldClass} aria-invalid={Boolean(fieldErrors.name)} />
            {fieldErrors.name && <span className="mt-1 block text-red-300">{fieldErrors.name}</span>}
          </label>
          <label className="text-xs font-medium text-slate-400">Type
            <select value={draft.accountType} onChange={(e) => setDraft({ ...draft, accountType: e.target.value as AccountType })} className={fieldClass}>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_SINGULAR[t]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400 sm:col-span-4">Description (optional)
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} className={fieldClass} />
          </label>
          <div className="sm:col-span-4"><button type="submit" disabled={busy} className={primaryButton}>{busy ? "Adding…" : "Add Account"}</button></div>
        </form>
      )}

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</p>}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3" role="search">
          <label className="min-w-[14rem] flex-1 text-xs font-medium text-slate-400">Search
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" maxLength={100} className={fieldClass} />
          </label>
          <label className="text-xs font-medium text-slate-400">Type
            <select value={type} onChange={(e) => setType(e.target.value as AccountType | "")} className={selectClass}>
              <option value="">All types</option>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">Status
            <select value={state} onChange={(e) => setState(e.target.value as "" | "active" | "inactive")} className={selectClass}>
              <option value="">Active and inactive</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>

        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">No accounts match.</p>
        ) : (
          ACCOUNT_TYPES.filter((t) => shown.some((a) => a.account_type === t)).map((t) => (
            <div key={t} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{ACCOUNT_TYPE_LABELS[t]}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
                    <tr><th className="px-3 py-2 font-semibold">Code</th><th className="px-3 py-2 font-semibold">Name</th><th className="px-3 py-2 font-semibold">Status</th><th className="px-3 py-2 text-right font-semibold">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {shown.filter((a) => a.account_type === t).map((a) => (
                      <tr key={a.id} className={a.is_active ? "" : "opacity-60"}>
                        <td className="px-3 py-2 font-mono text-xs font-semibold text-white">{a.code}</td>
                        <td className="px-3 py-2">
                          {editing === a.id ? (
                            <div className="space-y-2">
                              <input aria-label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={150} className={fieldClass} />
                              <input aria-label="Description" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={500} placeholder="Description" className={fieldClass} />
                            </div>
                          ) : (
                            <>
                              <div>{a.name}</div>
                              {a.description && <div className="text-xs text-slate-500">{a.description}</div>}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {a.is_system && <Pill style="border-indigo-500/30 bg-indigo-500/10 text-indigo-300">System</Pill>}
                            <Pill style={a.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}>{a.is_active ? "Active" : "Inactive"}</Pill>
                            {a.has_postings && <Pill style="border-sky-500/20 bg-sky-500/10 text-sky-300">Has postings</Pill>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {editing === a.id ? (
                              <>
                                <button type="button" disabled={busy} onClick={() => save(a)} className={primaryButton}>Save</button>
                                <button type="button" onClick={() => setEditing(null)} className={secondaryButton}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button type="button" onClick={() => { setEditing(a.id); setEdit({ name: a.name, description: a.description ?? "" }); setError(null); }} className={secondaryButton}>Edit</button>
                                {!a.is_system && (a.is_active
                                  ? <button type="button" disabled={busy} onClick={() => setActive(a, false)} className={secondaryButton}>Deactivate</button>
                                  : <button type="button" disabled={busy} onClick={() => setActive(a, true)} className={secondaryButton}>Reactivate</button>)}
                                {!a.is_system && !a.has_postings && <button type="button" disabled={busy} onClick={() => remove(a)} className={dangerButton}>Delete</button>}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
        <InfoNotice>
          System accounts cannot be deleted, deactivated or re-typed because Finance posts to them. An account that already has postings keeps its code and type, and can be
          deactivated instead of deleted: its history stays in your books.
        </InfoNotice>
      </section>
    </div>
  );
}
