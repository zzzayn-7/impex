"use client";

import { KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { createScanSession, lookupOnServer, type ScanSource } from "@/lib/scan";
import CameraScanner from "./camera-scanner";

// SCAN TO ADD: next to the product name of the Add Stock form. It reads a barcode or QR code (phone camera, USB / Bluetooth scanner that types the code and presses Enter, or typing) and hands
// the code to the form's Barcode box, so a new product is registered with the code printed on its goods. Before it does, the code is looked up (read-only, the same route as every scan): a code
// that already belongs to a product of the organization is refused with that product's name, so one code never ends up on two products. Nothing is saved here; the form's own Add product
// button is what saves, exactly as before.

export function ScanToAddModal({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
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
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "rejected") return setError(outcome.message);
      const lookup = outcome.result;
      if (lookup.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      if (lookup.kind === "found") {
        const { product } = lookup.result;
        return setError(`This code already belongs to ${product.name} (${product.sku}). Use Stock In on the Stock page to add stock to it.`);
      }
      if (lookup.kind === "retired") return setError(lookup.message);
      if (lookup.kind !== "not-found") return setError(lookup.message); // ambiguous, invalid, forbidden or the service is unavailable: the code cannot be checked, so it is not used
      onCode(outcome.code);
    } finally {
      setLooking(false);
    }
  }

  function submitTyped(source: ScanSource) {
    const raw = value;
    setValue("");
    void handle(raw, source);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault(); // a scanner's trailing Enter reads the code; it never submits the form behind
    submitTyped("scanner");
  }

  return (
    <Modal
      title="Scan to add"
      subtitle="Scan the barcode on the goods. It is put in the Barcode box of this new product; nothing is saved yet."
      onClose={onClose}
      size="md"
      footer={<button type="button" onClick={onClose} className={buttonClass.secondary}>Cancel</button>}
    >
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
        <div>
          <label htmlFor="scan-to-add-input" className="block text-xs font-medium text-ix-muted">Scan or type the barcode</label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="scan-to-add-input"
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
            <button type="button" disabled={looking || !value.trim()} onClick={() => submitTyped("manual")} className={`${buttonClass.primary} shrink-0`}>
              {looking ? "Checking…" : "Use this code"}
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

/** The "Scan to add" button with its dialog: `onCode` receives the scanned code (normalized, as the Inventory Service stores it) once it is known to be free. */
export function ScanToAddButton({ onCode, disabled = false, className }: { onCode: (code: string) => void; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog" className={className ?? `${buttonClass.secondary} shrink-0`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10" />
        </svg>
        Scan to add
      </button>
      {open && <ScanToAddModal onClose={() => setOpen(false)} onCode={(code) => { setOpen(false); onCode(code); }} />}
    </>
  );
}
