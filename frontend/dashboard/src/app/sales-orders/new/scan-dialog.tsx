"use client";

import { KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import CameraScanner from "@/app/scan/camera-scanner";
import { Modal } from "@/components/ui/modal";
import { buttonClass } from "@/components/ui/controls";
import type { PickerProduct } from "@/lib/order-form";
import { createScanSession, lookupOnServer, type ScanSource } from "@/lib/scan";

// SCAN PRODUCTS: find a product by its barcode / QR code / SKU, with the phone or laptop camera or a USB / Bluetooth scanner (which types the code
// and presses Enter). It only LOOKS the product up (the same read-only route as the Scan page) and hands the product, with its current stock, back
// to the order form. It never adds anything and never changes stock. There is deliberately no <form> here: this dialog sits inside the order form's
// page, and a scanner's Enter must not save the order.
export default function ScanDialog({ onFound, onClose }: { onFound: (product: PickerProduct) => void; onClose: () => void }) {
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
      const { product, stock } = lookup.result;
      if (!product.is_active) return setError(`${product.name} is archived, so it cannot be ordered. Restore it in Products first.`);
      onFound({ ...stock, category: stock.category ?? product.category });
    } finally {
      setLooking(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault(); // a scanner's trailing Enter looks the code up; it never submits the order
    const raw = value;
    setValue("");
    void handle(raw, "scanner");
  }

  return (
    <Modal
      title="Scan product"
      subtitle="Scan a barcode or QR code with the camera or a scanner, or type a SKU. The product is shown in the inventory list so you can add it."
      onClose={onClose}
      size="md"
      footer={<button type="button" onClick={onClose} className={buttonClass.secondary}>Cancel</button>}
    >
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
        <div>
          <label htmlFor="order-scan-input" className="block text-xs font-medium text-ix-muted">Scan or type a barcode, QR code or SKU</label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="order-scan-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
              placeholder="Scan, or type and press Enter"
              className="block w-full font-mono text-sm"
            />
            <button type="button" disabled={looking || !value.trim()} onClick={() => { const raw = value; setValue(""); void handle(raw, "manual"); }} className={`${buttonClass.primary} shrink-0`}>
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
