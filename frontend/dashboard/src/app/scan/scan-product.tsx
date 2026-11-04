"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { LookupResult, ScanResult, ScanSource, createScanSession, lookupOnServer } from "@/lib/scan";
import { StockAction, Warehouse, formatQuantity } from "@/lib/stock-validation";
import StockForm from "@/app/stock/stock-form";
import CameraScanner from "./camera-scanner";

const SCAN_ACTIONS: StockAction[] = ["in", "out", "transfer"];
const ACTION_BUTTONS: { action: StockAction; label: string }[] = [
  { action: "in", label: "Stock In" },
  { action: "out", label: "Stock Out" },
  { action: "transfer", label: "Transfer" },
];

type Notice = { tone: "info" | "error" | "success"; text: string } | null;

export default function ScanProduct({ warehouses }: { warehouses: Warehouse[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [looking, setLooking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [panel, setPanel] = useState<StockAction | null>(null);

  const activeWarehouses = useMemo(() => warehouses.filter((w) => w.is_active), [warehouses]);
  const session = useRef(createScanSession({ lookup: lookupOnServer })).current;
  const resultRef = useRef<ScanResult | null>(null);
  resultRef.current = result;

  // The scan box is where a keyboard-emulating USB/Bluetooth scanner "types". Keep it ready.
  useEffect(() => inputRef.current?.focus(), []);
  const refocus = () => window.setTimeout(() => inputRef.current?.focus(), 0);

  function show(lookup: LookupResult, code: string) {
    if (lookup.kind === "found") {
      const different = resultRef.current?.product.id !== lookup.result.product.id;
      setResult(lookup.result);
      setLastCode(code);
      if (different) setPanel(null); // a different product was scanned: the open form belonged to the previous one
      setNotice(null);
    } else if (lookup.kind === "unauthorized") {
      router.replace("/login");
      router.refresh();
    } else {
      setResult(null);
      setPanel(null);
      setNotice({ tone: "error", text: lookup.message });
    }
  }

  async function handle(raw: string, source: ScanSource) {
    setLooking(true);
    try {
      const outcome = await session.submit(raw, source);
      if (outcome.kind === "ignored") return; // the same code twice in a row: the first lookup already answered
      if (outcome.kind === "rejected") {
        setResult(null);
        setPanel(null);
        setNotice({ tone: "error", text: outcome.message });
        return;
      }
      show(outcome.result, outcome.code);
    } finally {
      setLooking(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); // a scanner's trailing Enter lands here
    const raw = value;
    setValue("");
    void handle(raw, "scanner");
    if (!panel) refocus();
  }

  function onCamera(text: string) {
    setCamera(false);
    void handle(text, "camera");
  }

  function clear() {
    setResult(null);
    setPanel(null);
    setNotice(null);
    setLastCode(null);
    session.reset();
    refocus();
  }

  // After a stock change: show the new quantities. The same lookup, no scan needed.
  async function afterOperation(message: string) {
    setPanel(null);
    if (lastCode) {
      const fresh = await lookupOnServer(lastCode);
      if (fresh.kind === "found") setResult(fresh.result);
    }
    setNotice({ tone: "success", text: message });
    refocus();
  }

  const product = result?.product;
  const stock = result?.stock;
  const archived = Boolean(product && !product.is_active);
  const noWarehouse = activeWarehouses.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Scan Product</h2>
        <p className="text-xs text-slate-400">
          Scan a QR code or barcode, or type a SKU. Scanning only looks the product up; stock changes only after you choose an action and confirm it.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <form onSubmit={onSubmit} role="search" aria-label="Find a product by code" className="space-y-3">
          <label htmlFor="scan-input" className="block text-xs font-medium text-slate-400">
            Scan or type a barcode, QR code or SKU
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={inputRef}
              id="scan-input"
              name="scan"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              inputMode="text"
              enterKeyHint="search"
              placeholder="Click here, then scan…"
              aria-describedby="scan-help"
              className="min-h-12 w-full flex-1 rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-base text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40"
            />
            <div className="flex gap-2">
              <button type="submit" disabled={looking || !value.trim()} className="min-h-12 flex-1 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 sm:flex-none">
                {looking ? "Looking…" : "Look up"}
              </button>
              <button type="button" onClick={() => setCamera((on) => !on)} aria-expanded={camera} className="min-h-12 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 sm:flex-none">
                {camera ? "Hide camera" : "Use camera"}
              </button>
            </div>
          </div>
          <p id="scan-help" className="text-xs text-slate-500">
            USB and Bluetooth scanners work as keyboards: keep the cursor in this box and scan; their Enter looks the product up.
          </p>
        </form>

        {camera && <CameraScanner onDetected={onCamera} onClose={() => setCamera(false)} />}
      </section>

      <div aria-live="polite" className="space-y-3">
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-lg border px-4 py-3 text-sm ${
              notice.tone === "error" ? "border-red-500/20 bg-red-500/10 text-red-300"
              : notice.tone === "success" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
              : "border-slate-700 bg-slate-900 text-slate-300"
            }`}
          >
            {notice.text}
          </div>
        )}
      </div>

      {product && stock && (
        <section aria-label="Scanned product" className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="break-words text-lg font-semibold text-white">{product.name}</h3>
              <p className="font-mono text-sm text-indigo-300">{product.sku}</p>
              <p className="mt-1 text-xs text-slate-400">
                Unit: <span className="font-medium text-slate-200">{product.unit}</span> ·{" "}
                {product.unit_allows_fractions ? "decimal quantities allowed" : "whole numbers only"} · found by{" "}
                {result.matched_by === "sku" ? "SKU" : result.identifier_kind === "generated" ? "Impex label" : `${result.identifier_kind} barcode`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {archived && <span className="rounded-full border border-slate-600/40 bg-slate-700/30 px-2.5 py-0.5 text-xs font-medium text-slate-300">Archived</span>}
              <button type="button" onClick={clear} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">Clear</button>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <dt className="text-xs text-slate-400">Total stock</dt>
              <dd className="mt-1 font-mono text-xl font-semibold text-white">{formatQuantity(stock.total_quantity)} <span className="text-sm font-normal text-slate-400">{product.unit}</span></dd>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <dt className="text-xs text-slate-400">Available stock</dt>
              <dd className="mt-1 font-mono text-xl font-semibold text-emerald-400">{formatQuantity(stock.available_quantity)} <span className="text-sm font-normal text-slate-400">{product.unit}</span></dd>
              {stock.available_quantity !== stock.total_quantity && <p className="mt-1 text-[11px] text-slate-500">in active warehouses only</p>}
            </div>
          </dl>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-slate-400">Stock by warehouse</h4>
            {stock.lines.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 px-4 py-4 text-sm text-slate-500">No stock recorded for this product yet.</p>
            ) : (
              <ul className="divide-y divide-slate-800/60 rounded-lg border border-slate-800">
                {stock.lines.map((line) => (
                  <li key={line.warehouse_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className={line.warehouse_active ? "text-slate-200" : "text-slate-500"}>
                      <span className="font-mono text-xs text-indigo-300">{line.warehouse_code}</span> {line.warehouse_name}
                      {!line.warehouse_active && <span className="ml-2 text-xs">(archived)</span>}
                    </span>
                    <span className="font-mono text-slate-100">{formatQuantity(line.quantity)} {product.unit}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {archived ? (
            <p role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              This product is archived. Restore it in Products before changing its stock.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Stock actions">
                {ACTION_BUTTONS.map(({ action, label }) => (
                  <button
                    key={action}
                    type="button"
                    disabled={noWarehouse}
                    aria-pressed={panel === action}
                    onClick={() => { setNotice(null); setPanel(panel === action ? null : action); }}
                    className={`min-h-12 rounded-lg px-2 py-2 text-sm font-semibold transition disabled:opacity-40 ${
                      panel === action ? "bg-indigo-600 text-white" : "border border-slate-700 text-slate-100 hover:bg-slate-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {noWarehouse && <p className="text-xs text-amber-300">Create a warehouse first (Warehouses) to record stock.</p>}
              {panel && !noWarehouse && (
                <StockForm
                  key={`${product.id}-${panel}`}
                  initialAction={panel}
                  initialProductId={product.id}
                  products={[product]}
                  warehouses={activeWarehouses}
                  actions={SCAN_ACTIONS}
                  requireConfirmation
                  lockProduct
                  onDone={afterOperation}
                  onCancel={() => { setPanel(null); refocus(); }}
                />
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
