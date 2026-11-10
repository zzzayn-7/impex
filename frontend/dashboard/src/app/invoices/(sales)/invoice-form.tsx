"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api, formatMoney, INVOICE_NOTICE, jsonBody, lineAmounts, MONEY_RE, moneyExceeds, qty, sumMoney } from "@/lib/sales-browser";
import { newIdempotencyKey } from "@/lib/stock-validation";
import type { BillableLine, Client, InvoiceDetail } from "@/lib/sales";
import QuantityInput from "@/components/ui/quantity-input";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const cellInput = "mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right font-mono text-sm text-white outline-none focus:border-indigo-500";

const today = () => new Date().toISOString().slice(0, 10);
const CURRENCIES = ["USD", "EUR", "GBP", "PKR", "AED", "SAR", "INR", "CNY", "JPY", "CAD", "AUD", "CHF"];

type Row = { open: boolean; quantity: string; unitPrice: string; discount: string; taxRate: string; taxLabel: string };
const EMPTY_ROW: Row = { open: false, quantity: "", unitPrice: "", discount: "", taxRate: "", taxLabel: "" };
const plain = (value: string) => qty(value).replace(/,/g, "");
/** Is the typed price a valid amount that differs from the one agreed on the sales order? (exact comparison, no floating point) */
const differs = (typed: string, agreed: string) => MONEY_RE.test(typed.trim()) && (moneyExceeds(typed.trim(), agreed) || moneyExceeds(agreed, typed.trim()));

/** The one currency every billable line was agreed in on its sales order, if there is exactly one (older orders have none). */
function agreedCurrency(billable: BillableLine[]): string | null {
  const codes = new Set(billable.map((l) => l.agreed_currency_code).filter((c): c is string => Boolean(c)));
  return codes.size === 1 ? Array.from(codes)[0] : null;
}

/** Create a DRAFT invoice (or edit one) from the CONFIRMED dispatches of one client. The administrator types every quantity, selling price,
 *  discount and tax rate; nothing is filled in from the catalog. The amounts shown are an exact preview: the Sales Service calculates them
 *  again when the draft is saved. Saving a draft changes no stock. */
export default function InvoiceForm({
  clients, clientId, billable, invoice, problem, defaultCurrency,
}: { clients: Client[]; clientId: string; billable: BillableLine[]; invoice: InvoiceDetail | null; problem?: string; defaultCurrency?: string }) {
  const router = useRouter();
  const keyRef = useRef(newIdempotencyKey()); // one key per attempt: a double click or a retry returns the same draft
  const [chosen, setChosen] = useState(clientId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [header, setHeader] = useState({
    // A NEW invoice starts in the organization's default currency (Settings); an existing invoice always keeps the currency it was made in.
    // ...unless the goods being billed were all agreed in ONE currency on their sales orders: then the invoice starts in that currency.
    currencyCode: invoice?.currency_code ?? agreedCurrency(billable) ?? defaultCurrency ?? "USD", invoiceDate: invoice?.invoice_date ?? today(), dueDate: invoice?.due_date ?? "", notes: invoice?.notes ?? "",
  });
  const savedHeader = useRef(header);
  const [rows, setRows] = useState<Record<string, Row>>(() => {
    const initial: Record<string, Row> = {};
    for (const line of invoice?.lines ?? []) {
      for (const a of line.allocations) {
        initial[a.dispatch_line_id] = {
          open: true, quantity: plain(a.quantity), unitPrice: plain(line.unit_price), discount: line.discount_amount === "0.0000" ? "" : plain(line.discount_amount),
          taxRate: line.tax_rate === "0.0000" ? "" : plain(line.tax_rate), taxLabel: line.tax_label ?? "",
        };
      }
    }
    return initial;
  });

  const rowOf = (id: string): Row => rows[id] ?? EMPTY_ROW;
  /** The price agreed on this line's sales order, when it is in the invoice's currency (nothing is ever converted); otherwise the price is typed by hand. */
  const agreedFor = (l: BillableLine) => Boolean(l.agreed_unit_price) && l.agreed_currency_code === header.currencyCode.trim().toUpperCase();
  const setRow = (id: string, patch: Partial<Row>) => {
    setRows((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_ROW), ...patch } }));
    setRowErrors((current) => ({ ...current, [id]: "" }));
  };

  // ---- step 1: choose the client (new invoices only) ----------------------------------------------------------------------------------------
  if (!clientId) {
    return (
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Choose a client">
        <p className="text-sm text-slate-300">An invoice bills one client for goods from their <strong>confirmed dispatches</strong>. Choose the client first.</p>
        {clients.filter((c) => c.is_active).length === 0 ? (
          <p role="status" className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
            You have no active client. Add one in <Link href="/clients" className="text-indigo-300 hover:text-indigo-200">Clients</Link> first.
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Client
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} className={fieldClass}>
                <option value="">Choose a client…</option>
                {clients.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <button type="button" disabled={!chosen} onClick={() => router.push(`/invoices/new?client=${chosen}`)} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Continue</button>
          </div>
        )}
      </section>
    );
  }

  const client = invoice?.client ?? clients.find((c) => c.id === clientId);
  const groups = new Map<string, BillableLine[]>();
  for (const line of billable) groups.set(line.dispatch_id, [...(groups.get(line.dispatch_id) ?? []), line]);
  const selected = billable.filter((l) => rowOf(l.dispatch_line_id).open);

  const previews = selected.map((l) => {
    const r = rowOf(l.dispatch_line_id);
    return { line: l, amounts: lineAmounts(r.quantity, r.unitPrice, r.discount, r.taxRate) };
  });
  const valid = previews.flatMap((p) => (p.amounts.ok ? [{ ...p, amounts: p.amounts }] : []));
  const sums = {
    subtotal: sumMoney(valid.map((p) => p.amounts.subtotal)),
    discount: sumMoney(valid.map((p) => lineDiscount(rowOf(p.line.dispatch_line_id)))),
    tax: sumMoney(valid.map((p) => p.amounts.tax)),
    total: sumMoney(valid.map((p) => p.amounts.total)),
  };

  function validate(): boolean {
    const errors: Record<string, string> = {};
    for (const p of previews) {
      const id = p.line.dispatch_line_id;
      const r = rowOf(id);
      if (!p.amounts.ok) errors[id] = p.amounts.message;
      else if (moneyExceeds(r.quantity.trim(), p.line.remaining_quantity)) {
        errors[id] = `Only ${qty(p.line.remaining_quantity)} ${p.line.unit} of ${p.line.product_name} can still be billed from ${p.line.dispatch_number}.`;
      } else if (r.quantity.trim().replace(/[0.]/g, "") === "") errors[id] = "Enter a quantity greater than zero.";
    }
    setRowErrors(errors);
    if (selected.length === 0) setError("Choose at least one dispatched product to bill.");
    else if (!/^[A-Za-z]{3}$/.test(header.currencyCode.trim())) setError("Use a 3-letter currency code such as USD, EUR or PKR.");
    return selected.length > 0 && Object.keys(errors).length === 0 && /^[A-Za-z]{3}$/.test(header.currencyCode.trim());
  }

  const linesBody = () => ({
    lines: selected.map((l) => {
      const r = rowOf(l.dispatch_line_id);
      return { dispatchLineId: l.dispatch_line_id, quantity: r.quantity.trim(), unitPrice: r.unitPrice.trim(), discountAmount: r.discount.trim(), taxRate: r.taxRate.trim(), taxLabel: r.taxLabel.trim() };
    }),
  });

  function failed(r: { status: number; error: string }) {
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey(); // that request was not accepted: the next attempt is a new one
    setError(r.error);
  }

  async function save() {
    if (busy) return;
    setError(null);
    if (!validate()) return;
    setBusy(true);
    let id = invoice?.id;
    if (!invoice) {
      const r = await api("/api/sales/invoices", {
        method: "POST", headers: { "Idempotency-Key": keyRef.current },
        ...jsonBody({ clientId, currencyCode: header.currencyCode.trim(), invoiceDate: header.invoiceDate, ...(header.dueDate ? { dueDate: header.dueDate } : {}), notes: header.notes, ...linesBody() }),
      });
      if (!r.ok) return failed(r);
      id = r.data.invoice.id;
    } else {
      if (JSON.stringify(header) !== JSON.stringify(savedHeader.current)) {
        const h = await api(`/api/sales/invoices/${invoice.id}`, {
          method: "PATCH", ...jsonBody({ invoiceDate: header.invoiceDate, ...(header.dueDate ? { dueDate: header.dueDate } : {}), notes: header.notes }),
        });
        if (!h.ok) return failed(h);
        savedHeader.current = header;
      }
      const r = await api(`/api/sales/invoices/${invoice.id}/lines`, { method: "PUT", ...jsonBody(linesBody()) });
      if (!r.ok) return failed(r);
    }
    router.push(`/invoices/${id}`);
  }

  return (
    <div className="space-y-5">
      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{INVOICE_NOTICE}</p>
      {invoice && <p role="status" className="text-xs text-slate-400">Editing the draft for {invoice.client.name}. It has no invoice number until it is issued.</p>}
      {problem && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{problem}</p>}

      <section className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-2 sm:p-5" aria-label="Invoice details">
        <div className="text-xs font-medium text-slate-400 sm:col-span-2">
          Client
          <p className="mt-1.5 text-sm font-semibold text-white">{client?.name ?? "Client"}{!invoice && <> · <Link href="/invoices/new" className="text-xs font-normal text-indigo-300 hover:text-indigo-200">Change client</Link></>}</p>
        </div>
        <label className="text-xs font-medium text-slate-400">
          Currency (3-letter code)
          <input value={header.currencyCode} onChange={(e) => setHeader({ ...header, currencyCode: e.target.value.toUpperCase() })} list="currency-codes" maxLength={3} disabled={Boolean(invoice)}
            autoCapitalize="characters" spellCheck={false} className={`${fieldClass} font-mono uppercase disabled:opacity-60`} />
          <datalist id="currency-codes">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          <span className="mt-1 block text-[11px] text-slate-500">One currency per invoice. Nothing is converted.</span>
        </label>
        <label className="text-xs font-medium text-slate-400">
          Invoice date
          <input type="date" value={header.invoiceDate} max={today()} onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Due date <span className="font-normal text-slate-500">(blank = 30 days after the invoice date)</span>
          <input type="date" value={header.dueDate} onChange={(e) => setHeader({ ...header, dueDate: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Notes
          <input value={header.notes} maxLength={2000} onChange={(e) => setHeader({ ...header, notes: e.target.value })} className={fieldClass} />
        </label>
      </section>

      <div className="space-y-4">
        {billable.length === 0 && (
          <p role="status" className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
            {client?.name ?? "This client"} has no confirmed dispatch to bill. Dispatch an order in <Link href="/delivery-lists" className="text-indigo-300 hover:text-indigo-200">Delivery Lists</Link> first.
          </p>
        )}
        {Array.from(groups.entries()).map(([dispatchId, lines]) => (
          <section key={dispatchId} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label={`Dispatch ${lines[0].dispatch_number}`}>
            <h3 className="text-sm font-semibold text-white">
              <Link href={`/dispatches/${dispatchId}`} className="font-mono text-indigo-300 hover:text-indigo-200">{lines[0].dispatch_number}</Link>
              <span className="ml-2 text-xs font-normal text-slate-400">dispatched {lines[0].dispatch_date} · list {lines[0].delivery_list.number}</span>
            </h3>
            {lines.map((l) => {
              const id = l.dispatch_line_id;
              const r = rowOf(id);
              const free = moneyExceeds(l.remaining_quantity, "0");
              const amounts = r.open ? lineAmounts(r.quantity, r.unitPrice, r.discount, r.taxRate) : null;
              return (
                <div key={id} data-testid={`bill-${l.product_sku}-${l.dispatch_number}`} className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-white">{l.product_name}</p>
                      <p className="font-mono text-xs text-indigo-300">{l.product_sku}</p>
                    </div>
                    <dl className="grid grid-cols-4 gap-3 text-right text-xs">
                      <div><dt className="text-slate-400">Dispatched</dt><dd className="font-mono text-sm text-white">{qty(l.dispatched_quantity)} {l.unit}</dd></div>
                      <div><dt className="text-slate-400">Invoiced</dt><dd className="font-mono text-sm text-white">{qty(l.invoiced_quantity)}</dd></div>
                      <div><dt className="text-slate-400">In drafts</dt><dd className="font-mono text-sm text-slate-300">{qty(l.in_drafts_quantity)}</dd></div>
                      <div><dt className="text-slate-400">Left to bill</dt><dd className="font-mono text-sm font-semibold text-emerald-400">{qty(l.remaining_quantity)}</dd></div>
                    </dl>
                  </div>
                  {rowErrors[id] && <p role="alert" className="text-sm text-red-400">{rowErrors[id]}</p>}
                  {!r.open ? (
                    free ? (
                      <button type="button" onClick={() => setRow(id, { open: true, ...(agreedFor(l) ? { unitPrice: plain(l.agreed_unit_price as string) } : {}) })} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Bill {l.product_name}</button>
                    ) : (
                      <p className="text-xs text-slate-500">Fully invoiced.</p>
                    )
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_8rem_auto] sm:items-end">
                        <div className="text-xs font-medium text-slate-400">
                          <label htmlFor={`bill-qty-${id}`} className="block">Quantity to bill</label>
                          <QuantityInput id={`bill-qty-${id}`} aria-label={`Quantity to bill of ${l.product_name} (${l.dispatch_number})`} value={r.quantity} onChange={(v) => setRow(id, { quantity: v })} className="mt-1.5" />
                        </div>
                        <label className="text-xs font-medium text-slate-400">
                          Selling price
                          <input aria-label={`Selling price of ${l.product_name} (${l.dispatch_number})`} value={r.unitPrice} inputMode="decimal" placeholder="0.00" onChange={(e) => setRow(id, { unitPrice: e.target.value })} className={cellInput} />
                        </label>
                        <label className="text-xs font-medium text-slate-400">
                          Discount (amount)
                          <input aria-label={`Discount for ${l.product_name} (${l.dispatch_number})`} value={r.discount} inputMode="decimal" placeholder="0" onChange={(e) => setRow(id, { discount: e.target.value })} className={cellInput} />
                        </label>
                        <label className="text-xs font-medium text-slate-400">
                          Tax rate (%)
                          <input aria-label={`Tax rate for ${l.product_name} (${l.dispatch_number})`} value={r.taxRate} inputMode="decimal" placeholder="0" onChange={(e) => setRow(id, { taxRate: e.target.value })} className={cellInput} />
                        </label>
                        <label className="text-xs font-medium text-slate-400">
                          Tax name
                          <input aria-label={`Tax name for ${l.product_name} (${l.dispatch_number})`} value={r.taxLabel} maxLength={50} placeholder="e.g. VAT" onChange={(e) => setRow(id, { taxLabel: e.target.value })}
                            className="mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-indigo-500" />
                        </label>
                        <button type="button" onClick={() => setRow(id, { ...EMPTY_ROW })} aria-label={`Remove ${l.product_name} (${l.dispatch_number}) from the invoice`} className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">Remove</button>
                      </div>
                      {l.agreed_unit_price && l.agreed_currency_code && (
                        <p data-testid={`agreed-${l.product_sku}-${l.dispatch_number}`} className={`text-xs ${differs(r.unitPrice, l.agreed_unit_price) || (l.agreed_currency_code !== header.currencyCode.trim().toUpperCase()) ? "text-amber-300" : "text-slate-400"}`}>
                          Agreed on {l.order_number ?? "the sales order"}: <span className="font-mono">{formatMoney(l.agreed_unit_price)} {l.agreed_currency_code}</span> per {l.unit}.
                          {l.agreed_currency_code !== header.currencyCode.trim().toUpperCase()
                            ? ` This invoice is in ${header.currencyCode.trim().toUpperCase() || "another currency"}: nothing is converted, so enter the price yourself.`
                            : differs(r.unitPrice, l.agreed_unit_price) ? " The price you typed is different from the agreed price." : ""}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <button type="button" onClick={() => setRow(id, { quantity: plain(l.remaining_quantity) })} className="font-medium text-indigo-300 hover:text-indigo-200">Bill all {qty(l.remaining_quantity)} {l.unit} that is left</button>
                        <span className="font-mono text-slate-300" data-testid={`amount-${l.product_sku}-${l.dispatch_number}`}>
                          {amounts?.ok ? <>Line total {formatMoney(amounts.total)} {header.currencyCode}{moneyExceeds(amounts.tax, "0") ? <span className="text-slate-500"> (includes tax {formatMoney(amounts.tax)})</span> : null}</> : <span className="text-slate-500">Enter the quantity and the price</span>}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <section aria-label="Invoice totals" className="ml-auto w-full max-w-sm space-y-1 rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm">
        <Total label="Subtotal" value={sums.subtotal} currency={header.currencyCode} />
        <Total label="Discount" value={sums.discount} currency={header.currencyCode} />
        <Total label="Tax" value={sums.tax} currency={header.currencyCode} />
        <div className="border-t border-slate-800 pt-1"><Total label="Total" value={sums.total} currency={header.currencyCode} strong /></div>
        <p className="pt-1 text-[11px] text-slate-500">A preview worked out exactly as the server does. The saved amounts are calculated again by the Sales Service.</p>
      </section>

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={invoice ? `/invoices/${invoice.id}` : "/invoices/sales"} className="text-sm text-indigo-300 hover:text-indigo-200">← {invoice ? "Back to the draft" : "All sales invoices"}</Link>
        <button type="button" onClick={save} disabled={busy || billable.length === 0} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Saving the draft…" : "Save draft and review"}</button>
      </div>
    </div>
  );
}

function lineDiscount(row: Row): string {
  return row.discount.trim() === "" ? "0" : row.discount.trim();
}

function Total({ label, value, currency, strong = false }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? "text-base font-semibold text-white" : "text-slate-300"}`}>
      <span>{label}</span>
      <span className="font-mono">{formatMoney(value)} <span className="text-xs text-slate-500">{currency}</span></span>
    </div>
  );
}
