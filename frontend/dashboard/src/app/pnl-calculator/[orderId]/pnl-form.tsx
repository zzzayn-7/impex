"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { IconAction } from "@/components/ui/icon-action";
import { computePnl, magnitude, MAX_OTHER_EXPENSES } from "@/lib/pnl";
import { formatMoney } from "@/lib/product-validation";
import { api, jsonBody } from "@/lib/sales-browser";
import type { OrderExpenses } from "@/lib/finance";
import type { OrderDetail } from "@/lib/sales";

// FINANCE > PNL CALCULATOR > ONE ORDER. The selling price is the order's own total (read-only). The person enters what the trade cost: the goods (filled in from the products' cost
// prices, and changeable), the delivery charges and any other expenses with their names. The result updates as they type and says plainly Profit or Loss and how much. "Save" keeps the
// figures so the list of orders can show the result. Nothing here is posted to the books.

const inputClass = "block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500";

type Row = { key: number; label: string; amount: string };
const plain = (value: string) => (/^0+(?:\.0+)?$/.test(value) ? "" : value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")); // "25.0000" -> "25", "0.0000" -> ""

export default function PnlForm({ order, saved, suggested }: { order: OrderDetail; saved: OrderExpenses | null; suggested: { value: string; complete: boolean; missing: number } }) {
  const router = useRouter();
  const currency = order.currency_code ?? "";
  const selling = order.total_amount ?? "0";
  const [goods, setGoods] = useState(saved ? plain(saved.goods_cost) : suggested.complete ? plain(suggested.value) : "");
  const [delivery, setDelivery] = useState(saved ? plain(saved.delivery_charges) : "");
  const [rows, setRows] = useState<Row[]>(saved ? saved.other_expenses.map((e, i) => ({ key: i, label: e.label, amount: plain(e.amount) })) : []);
  const [nextKey, setNextKey] = useState(saved ? saved.other_expenses.length : 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const result = computePnl({ selling, goods, delivery, others: rows.map((r) => ({ label: r.label, amount: r.amount })) });
  const unnamed = rows.some((r) => r.label.trim() === "" && r.amount.trim() !== "");

  const touch = () => setMessage(null);
  const setRow = (key: number, change: Partial<Row>) => { touch(); setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r))); };

  async function save() {
    if (busy || !result || unnamed) return;
    setBusy(true);
    setMessage(null);
    const r = await api(`/api/finance/order-expenses/${encodeURIComponent(order.id)}`, {
      method: "PUT",
      ...jsonBody({ goodsCost: goods, deliveryCharges: delivery, otherExpenses: rows.filter((x) => x.label.trim() !== "" || x.amount.trim() !== "").map((x) => ({ label: x.label, amount: x.amount })) }),
    });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    setMessage({ ok: true, text: "Saved" });
    router.refresh();
  }

  return (
    <section className="space-y-5" aria-label={`Profit or loss of ${order.number}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-xl font-semibold text-white">{order.number}</h2>
          <p className="mt-0.5 text-sm text-slate-400">{order.client.name}</p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 border-b border-slate-800 pb-3">
          <span className="text-sm text-slate-300">Selling price</span>
          <span data-selling className="font-mono text-lg font-semibold text-white">{formatMoney(selling, currency)}</span>
        </div>

        <label className="block text-xs font-medium text-slate-400">
          Cost of goods ({currency})
          <input inputMode="decimal" value={goods} onChange={(e) => { touch(); setGoods(e.target.value); }} aria-label="Cost of goods" placeholder="0" className={`${inputClass} mt-1.5 w-full sm:w-64`} />
          {!saved && (suggested.complete
            ? <span className="mt-1 block text-[11px] font-normal text-slate-500">From your products&apos; cost prices. You can change it.</span>
            : <span className="mt-1 block text-[11px] font-normal text-amber-300">{suggested.missing === 1 ? "One product has" : `${suggested.missing} products have`} no cost price in {currency}. Enter the cost yourself.</span>)}
        </label>

        <label className="block text-xs font-medium text-slate-400">
          Delivery charges ({currency})
          <input inputMode="decimal" value={delivery} onChange={(e) => { touch(); setDelivery(e.target.value); }} aria-label="Delivery charges" placeholder="0" className={`${inputClass} mt-1.5 w-full sm:w-64`} />
        </label>

        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="flex items-end gap-2" data-other-expense>
              <label className="flex-1 text-xs font-medium text-slate-400">
                Expense name
                <input value={row.label} maxLength={60} onChange={(e) => setRow(row.key, { label: e.target.value })} aria-label="Expense name" placeholder="e.g. Packing" className={`${inputClass} mt-1.5 w-full`} />
              </label>
              <label className="w-32 text-xs font-medium text-slate-400 sm:w-44">
                Amount ({currency})
                <input inputMode="decimal" value={row.amount} onChange={(e) => setRow(row.key, { amount: e.target.value })} aria-label="Expense amount" placeholder="0" className={`${inputClass} mt-1.5 w-full`} />
              </label>
              <IconAction kind="delete" label="Remove" ariaLabel={`Remove ${row.label || "expense"}`} variant="boxed" onClick={() => { touch(); setRows((all) => all.filter((r) => r.key !== row.key)); }} />
            </div>
          ))}
          {rows.length < MAX_OTHER_EXPENSES && (
            <button type="button" onClick={() => { touch(); setRows((all) => [...all, { key: nextKey, label: "", amount: "" }]); setNextKey((n) => n + 1); }}
              className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Add expense</button>
          )}
        </div>
      </div>

      <div data-result={result?.verdict ?? "invalid"} aria-live="polite" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        {result === null ? (
          <p className="text-sm text-red-300">Enter each amount as a number, for example 1250.50.</p>
        ) : (
          <>
            <dl className="space-y-1.5 text-sm">
              <Line label="Selling price" value={formatMoney(result.selling, currency)} />
              <Line label="Cost of goods" value={`− ${formatMoney(result.goods, currency)}`} />
              <Line label="Delivery charges" value={`− ${formatMoney(result.delivery, currency)}`} />
              {rows.filter((r) => r.label.trim() !== "" || r.amount.trim() !== "").map((r) => <Line key={r.key} label={r.label.trim() || "Other expense"} value={`− ${formatMoney(computePnl({ selling: "0", goods: "0", delivery: "0", others: [{ label: r.label, amount: r.amount }] })?.expenses ?? "0", currency)}`} />)}
            </dl>
            <div className="flex items-baseline justify-between gap-3 border-t border-slate-700 pt-3">
              <span data-verdict className={`text-lg font-semibold ${result.verdict === "loss" ? "text-red-300" : result.verdict === "profit" ? "text-ix-gain" : "text-slate-200"}`}>
                {result.verdict === "profit" ? "Profit" : result.verdict === "loss" ? "Loss" : "No profit, no loss"}
              </span>
              {result.verdict !== "even" && (
                <span data-amount className={`font-mono text-xl font-semibold ${result.verdict === "loss" ? "text-red-400" : "text-ix-gain"}`}>{formatMoney(magnitude(result.profit), currency)}</span>
              )}
            </div>
          </>
        )}
      </div>

      {message && <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p>}
      {unnamed && <p role="alert" className="text-sm text-red-300">Give every expense a name.</p>}
      <div className="flex justify-end">
        <button type="button" onClick={() => void save()} disabled={busy || !result || unnamed} className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}
