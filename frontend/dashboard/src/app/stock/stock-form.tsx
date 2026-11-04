"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { Product } from "@/lib/product-validation";
import {
  ACTION_LABELS,
  API_FIELD_NAMES,
  EMPTY_STOCK_FORM,
  STOCK_ACTIONS,
  StockAction,
  StockFieldErrors,
  StockFormValues,
  Warehouse,
  newIdempotencyKey,
  normalizeStock,
  toStockBody,
  validateStock,
} from "@/lib/stock-validation";

type Props = {
  initialAction: StockAction;
  initialProductId?: string;
  products: Product[]; // active products
  warehouses: Warehouse[]; // active warehouses
  onDone: (message: string) => void;
  onCancel: () => void;
  /** Which operations to offer (default: all four). The Scan Product page offers in / out / transfer. */
  actions?: StockAction[];
  /** Ask "are you sure?" with a plain-language summary before anything is sent. */
  requireConfirmation?: boolean;
  /** The product was chosen by a scan: show it, but do not let the form silently switch to another one. */
  lockProduct?: boolean;
};

const selectClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:ring-1 disabled:opacity-60";
const fieldBorder = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

const HELP: Record<StockAction, string> = {
  opening: "The starting quantity of a product in a warehouse. Only possible before any other movement there.",
  in: "Stock received into a warehouse.",
  out: "Stock leaving a warehouse. Refused if the warehouse does not hold enough.",
  transfer: "Move stock between two warehouses. Both sides are recorded together or not at all.",
};

export default function StockForm({
  initialAction, initialProductId, products, warehouses, onDone, onCancel, actions = STOCK_ACTIONS, requireConfirmation = false, lockProduct = false,
}: Props) {
  const router = useRouter();
  const [action, setAction] = useState<StockAction>(initialAction);
  const [values, setValues] = useState<StockFormValues>({ ...EMPTY_STOCK_FORM, productId: initialProductId ?? "" });
  const [errors, setErrors] = useState<StockFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set after the values pass validation when confirmation is required: nothing is sent until the user presses Confirm.
  const [confirming, setConfirming] = useState<string | null>(null);

  // One Idempotency-Key per intended action. Resubmitting the SAME values (a double click, a retry after a
  // timeout) reuses the key, so the change is applied once; changing anything starts a new action with a new key.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const product = products.find((p) => p.id === values.productId);
  const allowsFractions = product?.unit_allows_fractions ?? false;

  function update(field: keyof StockFormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setConfirming(null); // any change cancels a pending confirmation: what was summarised is no longer what is in the form
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function switchAction(next: StockAction) {
    setAction(next);
    setErrors({});
    setFormError(null);
    setConfirming(null);
    attempt.current = null;
  }

  const warehouseLabel = (id: string) => warehouses.find((w) => w.id === id)?.code ?? "the warehouse";

  function summary(normalized: StockFormValues): string {
    const what = `${normalized.quantity} ${product?.unit ?? ""} of ${product?.name ?? "the product"}`.replace(/\s+/g, " ");
    switch (action) {
      case "in": return `Add ${what} to ${warehouseLabel(normalized.warehouseId)}?`;
      case "out": return `Remove ${what} from ${warehouseLabel(normalized.warehouseId)}?`;
      case "opening": return `Record an opening balance of ${what} in ${warehouseLabel(normalized.warehouseId)}?`;
      case "transfer": return `Transfer ${what} from ${warehouseLabel(normalized.fromWarehouseId)} to ${warehouseLabel(normalized.toWarehouseId)}?`;
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return; // a second click while the first is in flight does nothing
    if (confirming) return; // Enter (or a scanner's Enter) while the question is showing must NOT count as "Confirm"
    setFormError(null);

    const normalized = normalizeStock(values);
    const found = validateStock(action, normalized, allowsFractions, product?.unit);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    if (requireConfirmation) {
      setConfirming(summary(normalized));
      return;
    }
    await send(normalized);
  }

  async function send(normalized: StockFormValues) {
    if (loading) return;
    const body = toStockBody(action, normalized);
    const fingerprint = JSON.stringify([action, body]);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newIdempotencyKey() };

    setLoading(true);
    try {
      const res = await fetch(`/api/stock/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        if (data?.fieldErrors) {
          const mapped: StockFieldErrors = {};
          for (const [name, message] of Object.entries(data.fieldErrors as Record<string, string>)) {
            const field = API_FIELD_NAMES[name] ?? (name as keyof StockFormValues);
            mapped[field] = message;
          }
          setErrors(mapped);
        }
        setFormError(data?.error ?? "That did not work. Please try again.");
        return;
      }
      const replayed = Boolean(data?.operation?.replayed);
      onDone(
        replayed
          ? "That request had already been applied; nothing was changed twice."
          : `${ACTION_LABELS[action].done} ${product ? `${product.name}: ${normalized.quantity} ${product.unit}.` : ""}`.trim()
      );
    } catch {
      // The request may or may not have arrived. Retrying with the same values is safe: the key makes it apply once.
      setFormError("Unable to reach the server. You can safely press the button again; the change will not be applied twice.");
    } finally {
      setLoading(false);
      setConfirming(null);
    }
  }

  const noOptions = products.length === 0 || warehouses.length === 0;

  return (
    <form onSubmit={onSubmit} noValidate aria-label={ACTION_LABELS[action].title} className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Stock action" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={a === action}
              onClick={() => switchAction(a)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${a === action ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"}`}
            >
              {ACTION_LABELS[a].title}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCancel} aria-label="Close form" className="text-slate-400 hover:text-white">✕</button>
      </div>
      <p className="text-xs text-slate-400">{HELP[action]}</p>

      {formError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</div>}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">
          Product
          <select value={values.productId} onChange={(e) => update("productId", e.target.value)} disabled={lockProduct} aria-invalid={Boolean(errors.productId)} className={`${selectClass} ${fieldBorder(errors.productId)}`}>
            <option value="">Choose a product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku}) — counted in {p.unit}</option>)}
          </select>
          {errors.productId && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.productId}</span>}
        </label>

        {action === "transfer" ? (
          <>
            <label className="text-xs font-medium text-slate-400">
              From warehouse
              <select value={values.fromWarehouseId} onChange={(e) => update("fromWarehouseId", e.target.value)} aria-invalid={Boolean(errors.fromWarehouseId)} className={`${selectClass} ${fieldBorder(errors.fromWarehouseId)}`}>
                <option value="">Choose…</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              {errors.fromWarehouseId && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.fromWarehouseId}</span>}
            </label>
            <label className="text-xs font-medium text-slate-400">
              To warehouse
              <select value={values.toWarehouseId} onChange={(e) => update("toWarehouseId", e.target.value)} aria-invalid={Boolean(errors.toWarehouseId)} className={`${selectClass} ${fieldBorder(errors.toWarehouseId)}`}>
                <option value="">Choose…</option>
                {warehouses.filter((w) => w.id !== values.fromWarehouseId).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              {errors.toWarehouseId && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.toWarehouseId}</span>}
            </label>
          </>
        ) : (
          <label className="text-xs font-medium text-slate-400 sm:col-span-2">
            Warehouse
            <select value={values.warehouseId} onChange={(e) => update("warehouseId", e.target.value)} aria-invalid={Boolean(errors.warehouseId)} className={`${selectClass} ${fieldBorder(errors.warehouseId)}`}>
              <option value="">Choose a warehouse…</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
            {errors.warehouseId && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.warehouseId}</span>}
          </label>
        )}

        <label className="text-xs font-medium text-slate-400">
          Quantity{product ? ` (${product.unit})` : ""}
          <input
            value={values.quantity}
            onChange={(e) => update("quantity", e.target.value)}
            inputMode={allowsFractions ? "decimal" : "numeric"}
            autoComplete="off"
            placeholder={allowsFractions ? "e.g. 12.5" : "e.g. 12"}
            aria-invalid={Boolean(errors.quantity)}
            className={`${selectClass} font-mono ${fieldBorder(errors.quantity)}`}
          />
          {errors.quantity ? (
            <span role="alert" className="mt-1 block text-xs text-red-400">{errors.quantity}</span>
          ) : product ? (
            <span className="mt-1 block text-[11px] text-slate-500">{allowsFractions ? "Decimals allowed (up to 4 places)." : "Whole numbers only."}</span>
          ) : null}
        </label>
        <label className="text-xs font-medium text-slate-400">
          Reason <span className="text-slate-600">(optional)</span>
          <input
            value={values.reason}
            onChange={(e) => update("reason", e.target.value)}
            maxLength={255}
            placeholder="e.g. Supplier delivery, stock count correction"
            aria-invalid={Boolean(errors.reason)}
            className={`${selectClass} ${fieldBorder(errors.reason)}`}
          />
          {errors.reason && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.reason}</span>}
        </label>
      </div>

      {confirming ? (
        // Nothing has been sent yet. Only a deliberate press of "Confirm" changes the inventory; the buttons are plain
        // buttons (not the form's submit), so a stray Enter from a scanner cannot confirm.
        <div role="alertdialog" aria-label="Confirm stock change" className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-200">{confirming}</p>
          <p className="text-xs text-amber-300/80">This changes your inventory and is recorded in the stock history.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setConfirming(null)} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60">Back</button>
            <button type="button" onClick={() => send(normalizeStock(values))} disabled={loading} className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
              {loading ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={loading || noOptions} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
            {loading ? "Saving…" : requireConfirmation ? "Review" : ACTION_LABELS[action].submit}
          </button>
        </div>
      )}
    </form>
  );
}
