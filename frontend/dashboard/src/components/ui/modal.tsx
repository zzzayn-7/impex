"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

// A centered glass dialog on the platform's own modal element: the browser traps keyboard focus inside it, closes it on Escape, makes the page
// behind inert and returns focus to the button that opened it. On top of that:
//   * the page behind does not scroll while it is open;
//   * a click on the dim backdrop closes it (unless `dismissable` is false, e.g. while a save is running);
//   * it never grows beyond 85% of the viewport: the header and the footer stay in view and the BODY scrolls inside it.
// Where the element is not available (test environments) it is shown as an ordinary open dialog.

export function Modal({ title, subtitle, onClose, children, footer, dismissable = true, size = "lg", labelledBy }: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  dismissable?: boolean;
  size?: "md" | "lg" | "xl";
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const width = { md: "max-w-lg", lg: "max-w-3xl", xl: "max-w-5xl" }[size];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; // the button that opened it
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // no background scrolling
    return () => {
      document.body.style.overflow = previous;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      if (opener && opener.isConnected) opener.focus(); // focus goes back to the button that opened it
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy ?? titleId}
      onCancel={(event) => { event.preventDefault(); if (dismissable) onClose(); }}
      onClick={(event) => { if (dismissable && event.target === ref.current) onClose(); }}
      className={`ix-glass fixed inset-auto left-1/2 top-1/2 !m-0 flex h-fit max-h-[85vh] -translate-x-1/2 -translate-y-1/2 w-[94vw] ${width} flex-col overflow-hidden rounded-[24px] p-0 text-ix-text backdrop:bg-[rgba(8,17,21,0.62)] backdrop:backdrop-blur-[3px] max-sm:max-h-[92vh] max-sm:w-[96vw]`}
    >
      <header className="relative flex shrink-0 items-start justify-between gap-4 border-b border-ix-mist/10 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={titleId} className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-ix-text">
            <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-ix-butter" />
            <span className="truncate">{title}</span>
          </h2>
          {subtitle && <div className="mt-1 text-xs text-ix-muted">{subtitle}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={!dismissable}
          aria-label="Close"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-ix-mist/15 bg-ix-mist/5 text-ix-muted transition-colors hover:bg-ix-mist/15 hover:text-ix-text disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div data-modal-body className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">{children}</div>
      {footer && <footer className="relative flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ix-mist/10 px-5 py-3.5 sm:px-6">{footer}</footer>}
    </dialog>
  );
}
