"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import type { Identifier, Label } from "@/lib/inventory";
import { Product, ProductFormValues, formatMoney } from "@/lib/product-validation";
import CodesManager from "./codes-manager";
import ProductForm from "./product-form";

// PRODUCT DIALOGS. With the standalone Products page gone from the menu, a product is looked at and corrected where it is used: from the Stock page
// (this dialog) and while buying (NewProductModal, from a purchase order). Both are centred dialogs on the platform's own modal element, so they take the
// user's chosen theme, and both talk only to the portal's /api/products routes; the Inventory Service remains the one place products are stored.
//
// Product INFORMATION (name, SKU, unit, prices, barcodes, status) is edited here; stock QUANTITIES are never touched here (they have their own Stock In /
// Stock Out / Opening balance forms and the goods receipt). Editing cannot break history: the unit of a product that already has stock movements is locked,
// and old orders, receipts, invoices and movements keep the names and prices they were created with.

type Loaded = { product: Product; identifiers: Identifier[]; label: Label | null };
type Tab = "details" | "barcodes";

export default function ProductModal({ productId, onClose, onChanged, startEditing = false }: {
  productId: string;
  /** Open straight on the edit form (the Stock table's edit icon). */
  startEditing?: boolean;
  onClose: () => void;
  /** Something was saved (details, status or barcodes): the page behind re-reads its figures. */
  onChanged: (message: string) => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  const [editing, setEditing] = useState(startEditing);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/products/${productId}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.status === 401) { router.replace("/login"); return; }
      if (!res.ok) { setFailure(body?.error ?? "The product could not be loaded. Please try again."); return; }
      setData({ product: body.product, identifiers: body.identifiers, label: body.label });
      setFailure(null);
    } catch {
      setFailure("Unable to reach the server. Please try again.");
    }
  }, [productId, router]);

  useEffect(() => { void load(); }, [load]);

  async function changeStatus(action: "archive" | "restore") {
    if (!data || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/products/${data.product.id}/${action}`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.status === 401) { router.replace("/login"); return; }
      if (!res.ok) { setMessage({ ok: false, text: body?.error ?? "That did not work. Please try again." }); return; }
      setConfirming(false);
      const text = action === "archive" ? `${data.product.name} was archived. It can be restored from the Stock page (Products: Archived).` : `${data.product.name} was restored.`;
      setMessage({ ok: true, text });
      onChanged(text);
      await load();
    } catch {
      setMessage({ ok: false, text: "Unable to reach the server. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const product = data?.product;
  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      id={`product-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`product-panel-${id}`}
      onClick={() => { setTab(id); setEditing(false); setConfirming(false); }}
      className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${tab === id ? "bg-ix-accent-text/10 text-ix-text shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-text-rgb)/0.3)]" : "text-ix-muted hover:bg-ix-mist/10 hover:text-ix-text"}`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title={product ? product.name : "Product"}
      subtitle={product && (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-mono text-ix-accent-text">{product.sku}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${product.is_active ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : "border-ix-mist/20 bg-ix-mist/10 text-ix-muted"}`}>{product.is_active ? "Active" : "Archived"}</span>
        </span>
      )}
      onClose={onClose}
      size="lg"
      footer={
        product && tab === "details" && !editing ? (
          confirming ? (
            <>
              <span className="mr-auto text-sm text-ix-muted">Archive this product? It leaves your lists; nothing is erased and it can be restored.</span>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={buttonClass.secondary}>Keep it</button>
              <button type="button" onClick={() => changeStatus("archive")} disabled={busy} className={buttonClass.destructive}>{busy ? "Archiving…" : "Yes, archive"}</button>
            </>
          ) : (
            <>
              {product.is_active ? (
                <button type="button" onClick={() => { setMessage(null); setConfirming(true); }} className={`${buttonClass.destructive} mr-auto`}>Archive</button>
              ) : (
                <button type="button" onClick={() => changeStatus("restore")} disabled={busy} className={`${buttonClass.secondary} mr-auto`}>{busy ? "Restoring…" : "Restore"}</button>
              )}
              <button type="button" onClick={onClose} className={buttonClass.secondary}>Done</button>
              <button type="button" onClick={() => { setMessage(null); setEditing(true); }} className={buttonClass.primary}>Edit product</button>
            </>
          )
        ) : undefined
      }
    >
      {failure ? (
        <p role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{failure}</p>
      ) : !data || !product ? (
        <p role="status" className="py-10 text-center text-sm text-ix-muted">Loading product…</p>
      ) : (
        <div className="space-y-4">
          <div role="tablist" aria-label="Product" className="flex flex-wrap gap-1.5">
            {tabButton("details", "Details")}
            {tabButton("barcodes", "Barcodes & labels")}
          </div>

          {message && (
            <div role={message.ok ? "status" : "alert"} className={`rounded-2xl border px-4 py-3 text-sm ${message.ok ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : "border-red-300/30 bg-red-400/10 text-red-200"}`}>
              {message.text}
            </div>
          )}

          {tab === "details" && (
            <div role="tabpanel" id="product-panel-details" aria-labelledby="product-tab-details">
              {editing ? (
                <ProductForm
                  embedded
                  product={product}
                  onCancel={() => setEditing(false)}
                  onDone={(text) => {
                    setEditing(false);
                    if (text !== "No changes to save.") { setMessage({ ok: true, text }); onChanged(text); void load(); }
                  }}
                />
              ) : (
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  <Item label="SKU" mono>{product.sku}</Item>
                  <Item label="Unit of measurement">
                    {product.unit}
                    {product.unit_locked && <span className="mt-0.5 block text-xs font-normal text-ix-muted">Locked: this product already has stock movements, so its unit can no longer change.</span>}
                  </Item>
                  <Item label="Product name" wide>{product.name}</Item>
                  <Item label="Description" wide>{product.description || <span className="text-ix-muted">—</span>}</Item>
                  <Item label="Cost price" mono>{formatMoney(product.cost_price, product.currency_code)}</Item>
                  <Item label="Selling price" mono>{formatMoney(product.selling_price, product.currency_code)}</Item>
                  <Item label="HS code" mono>{product.hs_code || <span className="text-ix-muted">—</span>}</Item>
                  <Item label="Status">{product.is_active ? "Active" : "Archived"}</Item>
                </dl>
              )}
            </div>
          )}

          {tab === "barcodes" && (
            <div role="tabpanel" id="product-panel-barcodes" aria-labelledby="product-tab-barcodes">
              <CodesManager product={product} identifiers={data.identifiers} label={data.label} onChanged={() => { onChanged(`Barcodes of ${product.name} were updated.`); void load(); }} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Item({ label, children, mono = false, wide = false }: { label: string; children: React.ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs font-medium text-ix-muted">{label}</dt>
      <dd className={`mt-1 text-sm text-ix-text ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

/** Register a NEW product (no stock is added). `defaults` carries what the caller already knows: the order's currency, the SKU that was searched for. */
export function NewProductModal({ defaults, withBarcode = true, title = "Add New Product", addLabel = "Add product", subtitle, onClose, onSaved }: {
  defaults?: Partial<ProductFormValues>;
  withBarcode?: boolean;
  title?: string;
  addLabel?: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** The product exists now (`message` says so, and whether its barcode could be registered). */
  onSaved: (product: Product, message: string) => void;
}) {
  return (
    <Modal
      title={title}
      subtitle={subtitle ?? "Registering a product does not add stock. Stock increases only when you confirm a goods receipt."}
      onClose={onClose}
      size="lg"
    >
      <ProductForm
        embedded
        defaults={defaults}
        withBarcode={withBarcode}
        addLabel={addLabel}
        onCancel={onClose}
        onSaved={(product, notes) => onSaved(product, `Added ${product.name} (${product.sku}).${notes.barcodeProblem ? ` The barcode was not registered: ${notes.barcodeProblem}` : ""}`)}
        onDone={() => undefined}
      />
    </Modal>
  );
}
