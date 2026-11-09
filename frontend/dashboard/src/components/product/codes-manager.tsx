"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { Identifier, Label } from "@/lib/inventory";
import type { Product } from "@/lib/product-validation";
import { normalizeScanned } from "@/lib/scan";

// `onChanged`: where the data is loaded by the caller (the Stock page's product dialog), it reloads it; otherwise the page itself is refreshed.
type Props = { product: Product; identifiers: Identifier[]; label: Label | null; onChanged?: () => void };

const svgSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const KIND_LABEL: Record<Identifier["kind"], string> = { generated: "Impex label", manufacturer: "Manufacturer", supplier: "Supplier" };
const MAX_COPIES = 24;

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1";
const fieldBorder = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

export default function CodesManager({ product, identifiers, label, onChanged }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [copies, setCopies] = useState(1);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "manufacturer", value: "", label: "" });
  const [errors, setErrors] = useState<{ value?: string; label?: string; kind?: string }>({});

  const refresh = () => (onChanged ? onChanged() : startTransition(() => router.refresh()));

  async function call(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
      }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Unable to reach the server. Please try again." } };
    }
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await call(`/api/products/${product.id}/identifiers/generate`, { method: "POST" });
    setBusy(false);
    if (!r.ok) return setMessage({ ok: false, text: r.data?.error ?? "That did not work. Please try again." });
    setMessage({ ok: true, text: "The QR code and barcode were generated." });
    refresh();
  }

  async function retire(identifier: Identifier) {
    if (busy) return;
    setBusy(true);
    const r = await call(`/api/products/${product.id}/identifiers/${identifier.id}/retire`, { method: "POST" });
    setBusy(false);
    setConfirmingId(null);
    if (!r.ok) return setMessage({ ok: false, text: r.data?.error ?? "That did not work. Please try again." });
    setMessage({ ok: true, text: `${identifier.value} was retired. It is kept and stays reserved for this product.` });
    refresh();
  }

  async function register(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); // also receives a scanner's Enter when the code is scanned into the box
    if (busy) return;
    setMessage(null);
    const code = normalizeScanned(form.value);
    if (!code.ok) return setErrors({ value: code.message });
    setErrors({});
    setBusy(true);
    const r = await call(`/api/products/${product.id}/identifiers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: form.kind, value: code.code, label: form.label }),
    });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.data?.fieldErrors ?? {});
      return setMessage({ ok: false, text: r.data?.error ?? "That did not work. Please try again." });
    }
    setForm({ kind: form.kind, value: "", label: "" });
    setMessage({ ok: true, text: `${code.code} now identifies ${product.name}.` });
    refresh();
  }

  const external = identifiers.filter((i) => i.kind !== "generated");

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <h2 className="text-xl font-semibold text-white">Codes &amp; labels</h2>
        <p className="mt-1 text-sm text-slate-300">
          {product.name} · <span className="font-mono text-indigo-300">{product.sku}</span> · {product.unit}
        </p>
      </div>

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2.5 text-sm print:hidden ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          {message.text}
        </div>
      )}

      {!label ? (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-5 print:hidden">
          <h3 className="text-sm font-semibold text-white">Impex label</h3>
          <p className="text-sm text-slate-400">
            This product has no QR code or barcode yet. Generating one gives it a permanent code that you can print on a label and scan in this portal.
            The SKU is not changed.
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={busy || !product.is_active}
            className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            {busy ? "Generating…" : "Generate QR code & barcode"}
          </button>
          {!product.is_active && <p className="text-xs text-amber-300">This product is archived. Restore it before generating codes.</p>}
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 print:hidden">
            <label className="text-xs font-medium text-slate-400">
              Copies to print
              <input
                type="number"
                min={1}
                max={MAX_COPIES}
                value={copies}
                onChange={(e) => setCopies(Math.max(1, Math.min(MAX_COPIES, Math.floor(Number(e.target.value)) || 1)))}
                className="mt-1.5 block w-24 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
              />
            </label>
            <button type="button" onClick={() => window.print()} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
              Print label{copies > 1 ? "s" : ""}
            </button>
            <p className="text-xs text-slate-500">Only the label is printed. Set the paper size to your label size in the print dialog.</p>
          </div>

          <div aria-label="Label preview" className="flex flex-wrap gap-4 print:gap-2">
            {Array.from({ length: copies }).map((_, i) => (
              <ProductLabel key={i} label={label} className={i === 0 ? "" : "hidden print:flex"} />
            ))}
          </div>

          <p className="text-xs text-slate-500 print:hidden">
            The QR code and the barcode both contain <span className="font-mono text-slate-300">{label.code}</span> as plain text, not a web address.
            It stays valid if the SKU or the product name changes.
          </p>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-5 print:hidden">
        <h3 className="text-sm font-semibold text-white">Manufacturer &amp; supplier barcodes</h3>
        <p className="text-xs text-slate-400">
          If the goods already carry a barcode, register it here so scanning it finds this product. One barcode can identify only one product in your catalog.
        </p>

        {external.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-4 text-sm text-slate-500">No manufacturer or supplier barcodes registered.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60 rounded-lg border border-slate-800">
            {external.map((identifier) => (
              <li key={identifier.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className={identifier.is_active ? "text-slate-200" : "text-slate-500 line-through"}>
                  <span className="font-mono">{identifier.value}</span>
                  <span className="ml-2 text-xs text-slate-400 no-underline">
                    {KIND_LABEL[identifier.kind]}{identifier.label ? ` · ${identifier.label}` : ""}{identifier.is_active ? "" : " · retired"}
                  </span>
                </span>
                {identifier.is_active &&
                  (confirmingId === identifier.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-slate-300">Retire this barcode?</span>
                      <button type="button" disabled={busy} onClick={() => retire(identifier)} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">Yes, retire</button>
                      <button type="button" onClick={() => setConfirmingId(null)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmingId(identifier.id)} aria-label={`Retire ${identifier.value}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-slate-800">Retire</button>
                  ))}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={register} noValidate aria-label="Register a barcode" className="grid gap-3 sm:grid-cols-6">
          <label className="text-xs font-medium text-slate-400 sm:col-span-2">
            Type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={`${inputClass} ${fieldBorder(errors.kind)}`}>
              <option value="manufacturer">Manufacturer barcode</option>
              <option value="supplier">Supplier barcode</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400 sm:col-span-2">
            Barcode (type it, or scan it into this box)
            <input
              value={form.value}
              onChange={(e) => { setForm({ ...form, value: e.target.value }); setErrors({ ...errors, value: undefined }); }}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
              aria-invalid={Boolean(errors.value)}
              placeholder="e.g. 5901234123457"
              className={`${inputClass} font-mono ${fieldBorder(errors.value)}`}
            />
            {errors.value && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.value}</span>}
          </label>
          <label className="text-xs font-medium text-slate-400 sm:col-span-2">
            Note <span className="text-slate-600">(optional, e.g. supplier name)</span>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={100} className={`${inputClass} ${fieldBorder(errors.label)}`} />
          </label>
          <div className="sm:col-span-6">
            <button type="submit" disabled={busy || !product.is_active} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
              {busy ? "Saving…" : "Register barcode"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// One printable label: product name, SKU, the QR code, the Code 128 barcode and the code in text (for typing it by hand).
function ProductLabel({ label, className = "" }: { label: Label; className?: string }) {
  return (
    <div
      className={`flex w-[72mm] break-inside-avoid flex-col gap-1.5 rounded-lg border border-slate-300 bg-white p-3 text-black shadow-sm print:rounded-none print:border-black print:shadow-none ${className}`}
    >
      <p className="break-words text-sm font-bold leading-tight">{label.product.name}</p>
      <p className="font-mono text-xs">SKU: {label.product.sku}</p>
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={svgSrc(label.qr_svg)} alt={`QR code ${label.code}`} className="h-24 w-24 shrink-0" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={svgSrc(label.barcode_svg)} alt={`Code 128 barcode ${label.code}`} className="h-16 min-w-0 flex-1" />
      </div>
      <p className="text-center font-mono text-xs tracking-wider">{label.code}</p>
    </div>
  );
}
