"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useVisibleViewport } from "@/lib/visual-viewport";
import { buttonClass } from "./controls";

// A confirmation dialog on the platform's own modal element: the browser traps focus inside it, closes it on Escape, makes the page behind inert, and
// returns focus to the button that opened it. Where the element is not available (very old browsers, test environments) the same question is asked
// with window.confirm, so a destructive action is never taken without asking.

export function ConfirmDialog({ open, title, message, confirmLabel, danger = true, onResolve }: {
  open: boolean; title: string; message: string; confirmLabel: string; danger?: boolean; onResolve: (confirmed: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useVisibleViewport(open); // centred in the part of the screen that is really visible, and never taller than it (see lib/visual-viewport.ts)
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
      className="ix-panel fixed inset-auto left-1/2 top-[calc(var(--ix-vv-top,0px)+var(--ix-vv-h,100dvh)/2)] !m-0 max-h-[calc(var(--ix-vv-h,100dvh)-1.5rem)] -translate-x-1/2 -translate-y-1/2 w-[min(calc(100vw-1.5rem),26rem)] overflow-y-auto overscroll-contain p-0 text-ix-text backdrop:bg-[rgba(8,17,21,0.62)] backdrop:backdrop-blur-[3px]"
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
