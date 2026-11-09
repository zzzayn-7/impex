"use client";

import { KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { createScanSession, lookupOnServer, type ScanResult, type ScanSource } from "@/lib/scan";
import CameraScanner from "./camera-scanner";

// SCAN PRODUCT: the portal's ONE way to identify a product by its barcode or QR code, from inside whatever the administrator is doing.
//
//   * Phone camera, USB / Bluetooth scanner (it types the code and presses Enter) or typing a SKU / barcode: all end in the same lookup, through the same
//     authenticated, read-only route as always (/api/scan/resolve), so manufacturer barcodes, Impex's own generated codes and SKUs all resolve, and a
//     code that belongs to another organization is simply "not found".
//   * A scan IDENTIFIES a product and hands it (with its current stock figures) to the screen that opened the dialog. It never saves, deducts, adds,
//     reserves or submits anything: what to do with the product is the screen's own, existing, confirmed workflow.
//   * The dialog is a modal over the current page: nothing navigates away and nothing in the form underneath is touched. It is rendered where the button
//     is (so it inherits the portal's theme), has no <form> of its own, and swallows Enter itself, so a scanner's Enter can never submit the form it sits in.
//   * `check` lets a screen refuse a product that does not belong there (for example "not on this purchase order") WITH a message, inside the dialog,
//     which stays open for the next scan.

type CheckFn = (result: ScanResult) => string | null;

export function ScanProductModal({ onFound, onClose, check, activeOnly = true }: {
  onFound: (result: ScanResult) => void;
  onClose: () => void;
  /** Return a message to refuse this product (the dialog stays open and shows it), or null to accept it. */
  check?: CheckFn;
  /** Archived products cannot be ordered, received or counted; pass false where an archived product may still be looked at (the catalog). */
  activeOnly?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [camera, setCamera] = useState(false);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(createScanSession({ lookup: lookupOnServer })).current;

  async function handle(raw: string, source: ScanSource) {
    setLooking(true);
    setError(null);
    try {
      const outcome = await session.submit(raw, source);
      if (outcome.kind === "ignored") return; // the same code twice in a row: the first lookup already answered
      if (outcome.kind === "rejected") return setError(outcome.message);
      const lookup = outcome.result;
      if (lookup.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      if (lookup.kind !== "found") return setError(lookup.message);
      const { product } = lookup.result;
      if (activeOnly && !product.is_active) return setError(`${product.name} is archived, so it cannot be used here. Restore it in Products first.`);
      const refused = check?.(lookup.result);
      if (refused) return setError(refused);
      onFound(lookup.result);
    } finally {
      setLooking(false);
    }
  }

  function submitTyped() {
    const raw = value;
    setValue("");
    void handle(raw, "manual");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault(); // a scanner's trailing Enter looks the code up; it never submits a form
    const raw = value;
    setValue("");
    void handle(raw, "scanner");
  }

  return (
    <Modal
      title="Scan Product"
      subtitle="Scan a barcode or QR code, or type a SKU. This only identifies the product: nothing is saved."
      onClose={onClose}
      size="md"
      footer={<button type="button" onClick={onClose} className={buttonClass.secondary}>Cancel</button>}
    >
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
        <div>
          <label htmlFor="scan-product-input" className="block text-xs font-medium text-ix-muted">Scan or type a barcode, QR code or SKU</label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="scan-product-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
              placeholder="Scan, or type and press Enter"
              className={`${fieldClass} !mt-0 font-mono`}
            />
            <button type="button" disabled={looking || !value.trim()} onClick={submitTyped} className={`${buttonClass.primary} shrink-0`}>
              {looking ? "Looking…" : "Find product"}
            </button>
          </div>
        </div>
        {camera ? (
          <CameraScanner onDetected={(text) => { setCamera(false); void handle(text, "camera"); }} onClose={() => setCamera(false)} />
        ) : (
          <button type="button" onClick={() => setCamera(true)} className={`${buttonClass.secondary} w-full`}>Use the camera</button>
        )}
      </div>
    </Modal>
  );
}

/** The "Scan Product" button with its dialog. Drop it next to any product field: `onFound` receives the identified product and its stock. */
export function ScanProductButton({ onFound, check, activeOnly, disabled = false, label = "Scan Product", className }: {
  onFound: (result: ScanResult) => void;
  check?: CheckFn;
  activeOnly?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog" className={className ?? `${buttonClass.secondary} shrink-0`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" /></svg>
        {label}
      </button>
      {open && <ScanProductModal activeOnly={activeOnly} check={check} onClose={() => setOpen(false)} onFound={(result) => { setOpen(false); onFound(result); }} />}
    </>
  );
}
