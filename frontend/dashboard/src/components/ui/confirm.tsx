"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { buttonClass } from "./controls";

// A confirmation dialog on the platform's own modal element: the browser traps focus inside it, closes it on Escape, makes the page behind inert, and
// returns focus to the button that opened it. Where the element is not available (very old browsers, test environments) the same question is asked
// with window.confirm, so a destructive action is never taken without asking.

export function ConfirmDialog({ open, title, message, confirmLabel, danger = true, onResolve }: {
  open: boolean; title: string; message: string; confirmLabel: string; danger?: boolean; onResolve: (confirmed: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal !== "function") return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby="ix-confirm-title"
      aria-describedby="ix-confirm-message"
      onCancel={(event) => { event.preventDefault(); onResolve(false); }}
      className="ix-panel m-auto w-[min(92vw,26rem)] p-0 text-ix-text backdrop:bg-ix-deep/70"
    >
      <div className="space-y-3 p-6">
        <h2 id="ix-confirm-title" className="text-base font-semibold">{title}</h2>
        <p id="ix-confirm-message" className="text-sm leading-relaxed text-ix-muted">{message}</p>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" autoFocus onClick={() => onResolve(false)} className={buttonClass.secondary}>Cancel</button>
          <button type="button" onClick={() => onResolve(true)} className={danger ? buttonClass.destructive : buttonClass.primary}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

type Ask = { title: string; message: string; confirmLabel: string; danger?: boolean };

/** `const [confirm, dialog] = useConfirm()`: `await confirm({...})` resolves true or false; render `dialog` once in the component. */
export function useConfirm(): [(ask: Ask) => Promise<boolean>, React.ReactNode] {
  const [pending, setPending] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((ask: Ask) => {
    if (typeof HTMLDialogElement === "undefined" || typeof HTMLDialogElement.prototype.showModal !== "function") return Promise.resolve(window.confirm(ask.message));
    return new Promise<boolean>((resolve) => setPending({ ...ask, resolve }));
  }, []);
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ""}
      message={pending?.message ?? ""}
      confirmLabel={pending?.confirmLabel ?? "Confirm"}
      danger={pending?.danger ?? true}
      onResolve={(ok) => { pending?.resolve(ok); setPending(null); }}
    />
  );
  return [confirm, dialog];
}
