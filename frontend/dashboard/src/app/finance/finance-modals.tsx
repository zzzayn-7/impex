"use client";

import { useEffect, useRef, useState } from "react";

import { Button, buttonClass, Field, SelectInput, TextArea, TextInput } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { CURRENCIES, currencyLabel } from "@/lib/currencies";
import type { Account, HistoryRow, ReconciliationItem } from "@/lib/finance";
import { api, jsonBody, MONEY_RE, subtractMoney } from "@/lib/finance-browser";
import { RECONCILIATION_HELP, todayISO, withCurrency } from "@/lib/finance-view";
import { formatMoney } from "@/lib/sales-browser";
import { newIdempotencyKey } from "@/lib/stock-validation";

type Errors = Record<string, string>;
const isPositive = (value: string) => MONEY_RE.test(value.trim()) && /[1-9]/.test(value);

function CurrencySelect({ value, onChange, id }: { value: string; onChange: (value: string) => void; id?: string }) {
  return (
    <SelectInput id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!CURRENCIES.some(([code]) => code === value) && <option value={value}>{value}</option>}
      {CURRENCIES.map(([code]) => <option key={code} value={code}>{currencyLabel(code)}</option>)}
    </SelectInput>
  );
}

function FormError({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-xl border border-red-300/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{message}</p> : null;
}

/** One saving request: it cannot be sent twice while it runs, and a retry of the SAME form reuses its Idempotency-Key, so a double click or a retry records ONE fact. */
function useSubmit(onDone: () => void) {
  const key = useRef(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  async function send(url: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": key.current }) {
    if (busy) return false; // the duplicate-submit guard
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const r = await api(url, { method: "POST", headers, ...jsonBody(body) });
    setBusy(false);
    if (r.ok) {
      onDone();
      return true;
    }
    if (r.status >= 400 && r.status < 500) key.current = newIdempotencyKey(); // a refused request releases its key: the corrected form is a new request
    setFieldErrors(r.fieldErrors ?? {});
    setError(r.status === 401 ? "Your session has expired. Please sign in again." : r.error);
    return false;
  }
  return { busy, error, fieldErrors, send, setError, setFieldErrors };
}

// ------------------------------------------------------------------------------------------------------------------------ Record Investment
export function RecordInvestmentModal({ defaultCurrency, onClose, onDone }: { defaultCurrency: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"contribution" | "withdrawal">("contribution");
  const [entryType, setEntryType] = useState<"cash" | "asset" | "inventory">("cash");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const form = useSubmit(onDone);
  const inKind = entryType !== "cash";

  async function submit() {
    const problems: Errors = {};
    if (!isPositive(amount)) problems.amount = inKind ? "Enter the valuation, above zero, with at most 4 decimals." : "Enter an amount above zero with at most 4 decimals.";
    if (!date) problems.effectiveDate = "Enter a date.";
    if (Object.keys(problems).length > 0) {
      form.setFieldErrors(problems);
      return form.setError("Please correct the highlighted fields.");
    }
    await form.send("/api/finance/investments", { kind, entryType, amount: amount.trim(), currencyCode: currency, effectiveDate: date, description, reference, notes });
  }

  return (
    <Modal
      title="Record Investment" size="md" onClose={onClose} dismissable={!form.busy}
      subtitle="Money or assets the owner puts into the business, or takes out of it. Buying stock is not an investment you record here: it is counted automatically from goods receipts."
      footer={<><Button onClick={onClose} disabled={form.busy}>Cancel</Button><Button kind="primary" onClick={() => void submit()} disabled={form.busy}>{form.busy ? "Saving…" : "Record"}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" aria-label="Record investment" noValidate>
        <FormError message={form.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <SelectInput value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Investment type">
              <option value="contribution">Owner contribution</option>
              <option value="withdrawal">Owner withdrawal</option>
            </SelectInput>
          </Field>
          <Field label="Form of the investment">
            <SelectInput value={entryType} onChange={(e) => setEntryType(e.target.value as typeof entryType)} aria-label="Form of the investment">
              <option value="cash">Cash / bank</option>
              <option value="asset">Asset given in kind</option>
              <option value="inventory">Stock given in kind</option>
            </SelectInput>
          </Field>
          <Field label={inKind ? "Valuation" : "Amount"} error={form.fieldErrors.amount}>
            <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label={inKind ? "Valuation" : "Amount"} aria-invalid={Boolean(form.fieldErrors.amount)} />
          </Field>
          <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
          <Field label="Date" error={form.fieldErrors.effectiveDate}>
            <TextInput type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          </Field>
          <Field label="Reference (optional)"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} aria-label="Reference" /></Field>
        </div>
        <Field label="Description (optional)"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} aria-label="Description" /></Field>
        <Field label="Notes (optional)"><TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} aria-label="Notes" /></Field>
        {inKind && (
          <p className="rounded-xl border border-ix-mist/15 bg-ix-deep/40 px-3 py-2 text-xs leading-relaxed text-ix-muted">
            {entryType === "inventory"
              ? "Stock the owner hands over is counted ONCE, at the valuation you enter. Do not also buy it through a purchase order, and record what each unit cost under “Stock cost” so a later sale has a real cost."
              : "An asset the owner hands over is counted ONCE, at the valuation you enter."}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Add Expense
export function ExpenseModal({ categories, defaultCurrency, onClose, onDone }: { categories: Account[]; defaultCurrency: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [accountId, setAccountId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const form = useSubmit(onDone);

  async function submit() {
    const problems: Errors = {};
    if (!description.trim()) problems.description = "Describe the expense.";
    if (!accountId) problems.accountId = "Choose an expense category.";
    if (!isPositive(amount)) problems.amount = "Enter an amount above zero with at most 4 decimals.";
    if (Object.keys(problems).length > 0) {
      form.setFieldErrors(problems);
      return form.setError("Please correct the highlighted fields.");
    }
    await form.send("/api/finance/expenses", { expenseDate: date, description, vendor, accountId, amount: amount.trim(), currencyCode: currency, post: true });
  }

  return (
    <Modal
      title="Add Expense" size="md" onClose={onClose} dismissable={!form.busy}
      subtitle="A cost of running the business. It is posted straight away and reduces the net result of the period it falls in."
      footer={<><Button onClick={onClose} disabled={form.busy}>Cancel</Button><Button kind="primary" onClick={() => void submit()} disabled={form.busy}>{form.busy ? "Saving…" : "Add expense"}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" aria-label="Add expense" noValidate>
        <FormError message={form.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" /></Field>
          <Field label="Category" error={form.fieldErrors.accountId}>
            <SelectInput value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Category">
              {categories.length === 0 && <option value="">No expense categories</option>}
              {categories.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Amount" error={form.fieldErrors.amount}>
            <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Amount" aria-invalid={Boolean(form.fieldErrors.amount)} />
          </Field>
          <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
        </div>
        <Field label="Description" error={form.fieldErrors.description}><TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} aria-label="Description" /></Field>
        <Field label="Paid to (optional)"><TextInput value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={150} aria-label="Paid to" /></Field>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Opening position
type Position = { id: string; currency_code: string; effective_date: string; assets: string; liabilities: string; equity: string; status: "active" | "reversed"; reversal_reason: string | null; notes: string | null };

export function OpeningPositionModal({ defaultCurrency, onClose, onDone }: { defaultCurrency: string; onClose: () => void; onDone: () => void }) {
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(todayISO());
  const [assets, setAssets] = useState("");
  const [liabilities, setLiabilities] = useState("");
  const [notes, setNotes] = useState("");
  const [positions, setPositions] = useState<Position[]>([]);
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const form = useSubmit(onDone);
  const load = async () => { const r = await api<{ items: Position[] }>("/api/finance/opening-positions"); if (r.ok && r.data) setPositions(r.data.items); };
  useEffect(() => { void load(); }, []);
  const active = positions.find((p) => p.currency_code === currency && p.status === "active");
  const valid = (value: string) => value.trim() === "" || MONEY_RE.test(value.trim());
  const equity = valid(assets) && valid(liabilities) ? subtractMoney(assets.trim() || "0", liabilities.trim() || "0") : null;

  async function submit() {
    const problems: Errors = {};
    if (!valid(assets)) problems.assets = "Enter what the business owned, with at most 4 decimals.";
    if (!valid(liabilities)) problems.liabilities = "Enter what the business owed, with at most 4 decimals.";
    if (Object.keys(problems).length > 0) {
      form.setFieldErrors(problems);
      return form.setError("Please correct the highlighted fields.");
    }
    await form.send("/api/finance/opening-positions", { currencyCode: currency, effectiveDate: date, assets: assets.trim() || "0", liabilities: liabilities.trim() || "0", notes });
  }

  async function reverse(id: string) {
    if (reason.trim().length < 3) return form.setError("Say why you are reversing it (at least 3 characters).");
    const ok = await form.send(`/api/finance/opening-positions/${id}/reverse`, { reason }, {});
    if (ok) { setReversing(null); setReason(""); }
  }

  return (
    <Modal
      title="Opening position" size="md" onClose={onClose} dismissable={!form.busy}
      subtitle="What the business owned and owed on the day you start: your capital is built from it. Nothing is assumed - until you set it (or record an owner contribution) capital shows “Setup required”."
      footer={<><Button onClick={onClose} disabled={form.busy}>Close</Button>{!active && <Button kind="primary" onClick={() => void submit()} disabled={form.busy}>{form.busy ? "Saving…" : "Set opening position"}</Button>}</>}
    >
      <div className="space-y-4">
        <FormError message={form.error} />
        {active ? (
          <div className="space-y-3 rounded-xl border border-ix-mist/15 bg-ix-deep/40 p-4 text-sm" data-testid="active-position">
            <p className="text-ix-text">An opening position in {currency} is set: assets {withCurrency(active.assets, currency)}, liabilities {withCurrency(active.liabilities, currency)}, owner equity <strong>{withCurrency(active.equity, currency)}</strong> on {active.effective_date}.</p>
            {reversing === active.id ? (
              <div className="space-y-2">
                <Field label="Why is it being reversed?"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Reason" /></Field>
                <div className="flex gap-2"><Button kind="destructive" onClick={() => void reverse(active.id)} disabled={form.busy}>Reverse it</Button><Button onClick={() => setReversing(null)}>Keep it</Button></div>
              </div>
            ) : (
              <Button onClick={() => setReversing(active.id)}>Reverse to correct it</Button>
            )}
            <p className="text-xs text-ix-muted">A position is never edited: it is reversed (and kept, with who and why) and a new one recorded.</p>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" aria-label="Opening position" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
              <Field label="As of"><TextInput type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="As of" /></Field>
              <Field label="What the business owned (assets)" error={form.fieldErrors.assets}>
                <TextInput inputMode="decimal" value={assets} onChange={(e) => setAssets(e.target.value)} placeholder="Stock, cash, equipment, money owed to you" aria-label="Assets" aria-invalid={Boolean(form.fieldErrors.assets)} />
              </Field>
              <Field label="What the business owed (liabilities)" error={form.fieldErrors.liabilities}>
                <TextInput inputMode="decimal" value={liabilities} onChange={(e) => setLiabilities(e.target.value)} placeholder="Loans, money owed to suppliers" aria-label="Liabilities" aria-invalid={Boolean(form.fieldErrors.liabilities)} />
              </Field>
            </div>
            <p data-testid="equity-preview" className="rounded-xl border border-ix-mist/15 bg-ix-deep/40 px-3 py-2 text-sm text-ix-text">Owner equity (assets minus liabilities): <strong>{equity === null ? "—" : withCurrency(equity, currency)}</strong></p>
            <Field label="Notes (optional)"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} aria-label="Notes" /></Field>
          </form>
        )}
        {positions.some((p) => p.status === "reversed") && (
          <div className="text-xs text-ix-muted">
            <p className="font-medium">Reversed positions (kept)</p>
            <ul className="mt-1 space-y-1">{positions.filter((p) => p.status === "reversed").map((p) => <li key={p.id}>{p.currency_code} {formatMoney(p.equity)} on {p.effective_date}: {p.reversal_reason}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Stock cost
type ProductHit = { id: string; sku: string; name: string; unit?: string };
type CostRow = { product_id: string; sku: string; name: string; currency_code: string; quantity: string; total_value: string; average_cost: string | null };

export function StockCostModal({ defaultCurrency, onClose, onDone, product: preset }: { defaultCurrency: string; onClose: () => void; onDone: () => void; product?: { id: string; sku: string; name: string } }) {
  const [query, setQuery] = useState(preset ? `${preset.sku} ${preset.name}` : "");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [product, setProduct] = useState<ProductHit | null>(preset ?? null);
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(todayISO());
  const [costs, setCosts] = useState<CostRow[]>([]);
  const form = useSubmit(onDone);
  useEffect(() => { void api<{ items: CostRow[] }>("/api/finance/inventory-costs").then((r) => { if (r.ok && r.data) setCosts(r.data.items); }); }, []);
  useEffect(() => {
    if (product || query.trim().length < 2) { setHits([]); return; }
    const handle = setTimeout(() => { void api<{ items: ProductHit[] }>(`/api/products?q=${encodeURIComponent(query.trim())}&limit=6`).then((r) => setHits(r.ok && r.data ? r.data.items : [])); }, 250);
    return () => clearTimeout(handle);
  }, [query, product]);

  async function submit() {
    const problems: Errors = {};
    if (!product) problems.productId = "Choose a product.";
    if (!isPositive(quantity)) problems.quantity = "Enter a quantity above zero.";
    if (!isPositive(unitCost)) problems.unitCost = "Enter what ONE unit cost, above zero.";
    if (Object.keys(problems).length > 0) {
      form.setFieldErrors(problems);
      return form.setError("Please correct the highlighted fields.");
    }
    await form.send("/api/finance/inventory-costs", { productId: product!.id, quantity: quantity.trim(), unitCost: unitCost.trim(), currencyCode: currency, effectiveDate: date });
  }

  return (
    <Modal
      title="Stock cost" size="md" onClose={onClose} dismissable={!form.busy}
      subtitle="What stock you already hold cost you per unit. Deliveries take their cost of goods sold from it, so a profit is never worked out from a guess. This changes no capital figure."
      footer={<><Button onClick={onClose} disabled={form.busy}>Cancel</Button><Button kind="primary" onClick={() => void submit()} disabled={form.busy}>{form.busy ? "Saving…" : "Record stock cost"}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" aria-label="Stock cost" noValidate>
        <FormError message={form.error} />
        <Field label="Product" error={form.fieldErrors.productId}>
          <TextInput value={query} onChange={(e) => { setQuery(e.target.value); setProduct(null); }} placeholder="Search by SKU or name" aria-label="Product" autoComplete="off" />
        </Field>
        {hits.length > 0 && (
          <ul aria-label="Matching products" className="max-h-40 overflow-y-auto rounded-xl border border-ix-mist/15 bg-ix-deep/60 text-sm">
            {hits.map((h) => (
              <li key={h.id}><button type="button" onClick={() => { setProduct(h); setQuery(`${h.sku} ${h.name}`); setHits([]); }} className="block w-full px-3 py-2 text-left text-ix-text hover:bg-ix-mist/10">{h.sku} — {h.name}</button></li>
            ))}
          </ul>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity on hand" error={form.fieldErrors.quantity}><TextInput inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-label="Quantity" aria-invalid={Boolean(form.fieldErrors.quantity)} /></Field>
          <Field label="Cost of ONE unit" error={form.fieldErrors.unitCost}><TextInput inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} aria-label="Cost of one unit" aria-invalid={Boolean(form.fieldErrors.unitCost)} /></Field>
          <Field label="Currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
          <Field label="As of"><TextInput type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="As of" /></Field>
        </div>
        {costs.length > 0 && (
          <div className="text-xs text-ix-muted">
            <p className="font-medium">Cost on record</p>
            <ul className="mt-1 space-y-1">{costs.map((c) => <li key={`${c.product_id}-${c.currency_code}`}>{c.sku} — {c.name}: {formatMoney(c.quantity)} in stock at {c.average_cost ? withCurrency(c.average_cost, c.currency_code) : "—"} each</li>)}</ul>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Reconcile deliveries
export function ReconcileModal({ onClose, onDone, focus }: { onClose: () => void; onDone: () => void; focus?: string | null }) {
  const [items, setItems] = useState<ReconciliationItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("");
  const [reason, setReason] = useState("");
  const [stockFor, setStockFor] = useState<ReconciliationItem | null>(null);
  const form = useSubmit(() => { setOpen(null); setPrice(""); setCost(""); setReason(""); void load(); onDone(); });
  const load = async () => { const r = await api<{ items: ReconciliationItem[] }>("/api/finance/reconciliation"); setItems(r.ok && r.data ? r.data.items : []); };
  useEffect(() => { void load(); }, []);

  if (stockFor) {
    return <StockCostModal defaultCurrency={stockFor.currency_code ?? "USD"} product={{ id: stockFor.product_id, sku: stockFor.sku, name: stockFor.name }} onClose={() => setStockFor(null)} onDone={() => { setStockFor(null); void load(); onDone(); }} />;
  }

  async function settle(item: ReconciliationItem) {
    const problems: Errors = {};
    if (item.status === "needs_price" && !isPositive(price)) problems.unitPrice = "Enter the price of ONE unit agreed with the client.";
    if (item.status === "needs_price" && !item.currency_code && !currency) problems.currencyCode = "Choose the currency.";
    if (cost.trim() !== "" && !MONEY_RE.test(cost.trim())) problems.unitCost = "Enter the cost of ONE unit.";
    if (item.status === "needs_cost" && cost.trim() === "") problems.unitCost = "Enter the cost of ONE unit.";
    if (reason.trim().length < 3) problems.reason = "Say how you know it (at least 3 characters).";
    if (Object.keys(problems).length > 0) {
      form.setFieldErrors(problems);
      return form.setError("Please correct the highlighted fields.");
    }
    await form.send(`/api/finance/deliveries/${item.delivery_id}/reconcile`, { ...(item.status === "needs_price" ? { unitPrice: price.trim() } : {}), ...(cost.trim() ? { unitCost: cost.trim() } : {}), ...(currency && !item.currency_code ? { currencyCode: currency } : {}), reason }, {});
  }

  return (
    <Modal title="Reconcile deliveries" size="lg" subtitle={RECONCILIATION_HELP} onClose={onClose} dismissable={!form.busy} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <FormError message={form.error} />
        {items === null && <p className="text-sm text-ix-muted">Loading…</p>}
        {items !== null && items.length === 0 && <p className="rounded-xl border border-dashed border-ix-mist/15 px-4 py-8 text-center text-sm text-ix-muted">Nothing needs reconciling.</p>}
        {items?.map((item) => (
          <div key={item.delivery_id} data-testid="reconcile-item" className="space-y-3 rounded-2xl border border-ix-mist/15 bg-ix-deep/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ix-text">{item.client_name} — {formatMoney(item.quantity).replace(/\.00$/, "")} × {item.name}</p>
                <p className="text-xs text-ix-muted">{item.order_number ?? item.dispatch_number} · {item.status === "needs_cost" ? `Revenue ${item.revenue ? withCurrency(item.revenue, item.currency_code ?? "") : "—"}, cost unknown` : "No price was recorded on the order"}</p>
              </div>
              <Button onClick={() => { setOpen(open === item.delivery_id ? null : item.delivery_id); form.setError(null); form.setFieldErrors({}); }}>{open === item.delivery_id ? "Close" : "Reconcile"}</Button>
            </div>
            {open === item.delivery_id && (
              <div className="space-y-3 border-t border-ix-mist/10 pt-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  {item.status === "needs_price" && (
                    <Field label="Price of ONE unit" error={form.fieldErrors.unitPrice}><TextInput inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price of one unit" /></Field>
                  )}
                  {item.status === "needs_price" && !item.currency_code && (
                    <Field label="Currency" error={form.fieldErrors.currencyCode}>
                      <SelectInput value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency"><option value="">Choose…</option>{CURRENCIES.map(([code]) => <option key={code} value={code}>{currencyLabel(code)}</option>)}</SelectInput>
                    </Field>
                  )}
                  <Field label="Actual cost of ONE unit" error={form.fieldErrors.unitCost}><TextInput inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Actual cost of one unit" /></Field>
                </div>
                <Field label="How do you know? (kept in the audit trail)" error={form.fieldErrors.reason}><TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label="Reason" /></Field>
                <div className="flex flex-wrap gap-2">
                  <Button kind="primary" onClick={() => void settle(item)} disabled={form.busy}>{form.busy ? "Saving…" : "Settle this delivery"}</Button>
                  {item.status === "needs_cost" && <button type="button" onClick={() => setStockFor(item)} className={buttonClass.secondary}>Record the stock cost instead</button>}
                </div>
                <p className="text-xs text-ix-muted">What you enter is final. Recording the cost of the stock you hold settles every waiting delivery of that product at once.</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Reverse a record
export function ReverseModal({ row, onClose, onDone }: { row: HistoryRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const form = useSubmit(onDone);
  const id = row.source_id;
  async function submit() {
    if (reason.trim().length < 3) return form.setError("Say why you are reversing it (at least 3 characters).");
    if (!id) return form.setError("This record cannot be reversed.");
    await form.send(`/api/finance/investments/${id}/reverse`, { reason }, {});
  }
  return (
    <Modal
      title="Reverse this record" size="md" onClose={onClose} dismissable={!form.busy}
      subtitle="Nothing is deleted: a reversing record is added, and both stay in the history with who did it and why."
      footer={<><Button onClick={onClose} disabled={form.busy}>Cancel</Button><Button kind="destructive" onClick={() => void submit()} disabled={form.busy}>{form.busy ? "Saving…" : "Reverse"}</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" aria-label="Reverse record" noValidate>
        <FormError message={form.error} />
        <p className="text-sm text-ix-text">{row.transaction}: {row.description} ({row.amount ? formatMoney(row.amount) : ""} {row.currency_code})</p>
        <Field label="Why is it being reversed?"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Reason" /></Field>
      </form>
    </Modal>
  );
}
