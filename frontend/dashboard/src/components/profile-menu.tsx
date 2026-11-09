"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useThemeOptional } from "@/components/theme/theme-provider";

// The signed-in administrator in the header: just the round avatar. Hovering it (a mouse), focusing it (the keyboard) or tapping it (a phone) opens a small
// dark-glass card with who they are: name, role, user id (and the organization where there is one). Escape, a tap elsewhere or moving away closes it.
// The card is always in the page but invisible while closed (visibility hidden), so it is neither seen nor read out until it opens.
// This file is an identical copy in both portals (like the tooltip): keep them in sync.

export default function ProfileMenu({ name, email, userId, role, initials, organization, organizationMark, appearance = false }: {
  name: string;
  email: string;
  userId: string;
  role: string;
  initials: string;
  organization?: string | null;
  /** The organization's logo or monogram, shown beside its name. */
  organizationMark?: ReactNode;
  /** Offer "Customize Theme" in the card (it opens the same customizer as the header's palette button). */
  appearance?: boolean;
}) {
  const theme = useThemeOptional();
  const cardId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const pointer = useRef("mouse");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const avatar = "grid shrink-0 place-items-center rounded-full border border-ix-accent-text/30 bg-ix-slate/60 font-semibold text-ix-accent-text";

  return (
    <div
      ref={wrap}
      className="relative"
      onPointerEnter={(event) => { if (event.pointerType !== "touch") setOpen(true); }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    >
      <button
        type="button"
        aria-label={`Account: ${name}`}
        aria-expanded={open}
        aria-controls={cardId}
        onPointerDown={(event) => { pointer.current = event.pointerType || "mouse"; }}
        onClick={() => setOpen((was) => (pointer.current === "touch" ? !was : true))}
        className={`${avatar} h-10 w-10 text-xs transition-colors hover:border-ix-accent-text/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60`}
      >
        {initials}
      </button>
      {/* pt-2 keeps the card attached to the avatar, so the pointer can travel from one to the other without it closing */}
      <div
        id={cardId}
        role="group"
        aria-label="Account details"
        className={`absolute right-0 top-full z-50 w-[min(18rem,calc(100vw-2rem))] pt-2 transition duration-150 motion-reduce:transition-none ${open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0"}`}
      >
        <div className="ix-menu p-3.5 text-left">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className={`${avatar} h-11 w-11 text-sm`}>{initials}</div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ix-text">{name}</p>
              <p className="truncate text-xs text-ix-muted">{email}</p>
            </div>
          </div>
          <dl className="mt-3 space-y-2.5 border-t border-ix-mist/10 pt-3 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ix-muted">Role</dt>
              <dd className="font-medium text-ix-text">{role}</dd>
            </div>
            <div>
              <dt className="text-ix-muted">User ID</dt>
              <dd className="mt-0.5 break-all font-mono text-[11px] leading-snug text-ix-text">{userId}</dd>
            </div>
            {organization ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ix-muted">Organization</dt>
                <dd className="flex min-w-0 items-center justify-end gap-2 font-medium text-ix-text">
                  {organizationMark}
                  <span className="truncate">{organization}</span>
                </dd>
              </div>
            ) : null}
          </dl>
          {appearance && theme ? (
            <button
              type="button"
              onClick={() => { theme.setOpen(true); setOpen(false); }}
              className="mt-3 flex w-full items-center gap-2 rounded-xl border border-ix-mist/15 bg-ix-mist/5 px-3 py-2 text-left text-xs font-medium text-ix-text transition-colors hover:bg-ix-mist/10 hover:text-ix-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" /><path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01" /></svg>
              Appearance
              <span className="ml-auto text-ix-muted">Customize Theme</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
