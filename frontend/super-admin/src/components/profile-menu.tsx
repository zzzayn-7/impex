"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useThemeOptional } from "@/components/theme/theme-provider";

// The signed-in administrator in the header: just the round avatar (their profile picture, or their initials). Hovering it (a mouse), focusing it (the keyboard) or tapping it
// (a phone) opens a small dark-glass card with who they are: name, e-mail and the details as "Label : value" lines, labels in the accent colour, all left aligned.
// With `avatarEditable` the card also lets them add, change or remove their own picture. Escape, a tap elsewhere or moving away closes the card.
// The card is always in the page but invisible while closed (visibility hidden), so it is neither seen nor read out until it opens.
// This file is an identical copy in both portals (like the tooltip): keep them in sync.

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

function Face({ url, initials, className }: { url?: string | null; initials: string; className: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const base = "grid shrink-0 place-items-center overflow-hidden rounded-full border border-ix-accent-text/30 bg-ix-slate/60 font-semibold text-ix-accent-text";
  return url && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" onError={() => setBroken(true)} data-testid="profile-picture" className={`${base} object-cover ${className}`} />
  ) : (
    <span aria-hidden="true" className={`${base} ${className}`}>{initials}</span>
  );
}

/** Add / change / remove the picture. Only rendered where the portal offers it (it needs the router, to show the new picture). */
function PictureControls({ has, endpoint }: { has: boolean; endpoint: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(init: RequestInit, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, { ...init, cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage({ ok: false, text: typeof body?.error === "string" ? body.error : "The picture could not be saved. Please try again." });
        return;
      }
      setMessage({ ok: true, text: done });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Unable to reach the server. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  function choose(file: File | undefined) {
    if (!file) return;
    if (!TYPES.includes(file.type)) return setMessage({ ok: false, text: "Use a PNG, JPEG or WebP picture." });
    if (file.size > MAX_BYTES) return setMessage({ ok: false, text: "The picture must be 2 MB or smaller." });
    const form = new FormData();
    form.set("file", file, "profile-picture");
    void send({ method: "PUT", body: form }, "Profile picture saved.");
  }

  const action = "rounded-lg border border-ix-mist/15 bg-ix-mist/5 px-2.5 py-1.5 text-xs font-medium text-ix-text transition-colors hover:bg-ix-mist/10 hover:text-ix-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="mt-3 border-t border-ix-mist/10 pt-3">
      <input
        ref={input} type="file" accept={TYPES.join(",")} hidden aria-label="Choose a profile picture" data-testid="profile-picture-input"
        onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className={action}>{busy ? "Saving…" : has ? "Change profile picture" : "Add profile picture"}</button>
        {has && <button type="button" disabled={busy} onClick={() => void send({ method: "DELETE" }, "Profile picture removed.")} className={action}>Remove</button>}
      </div>
      {message && <p role={message.ok ? "status" : "alert"} className={`mt-2 text-xs ${message.ok ? "text-ix-accent-text" : "text-red-300"}`}>{message.text}</p>}
    </div>
  );
}

export default function ProfileMenu({ name, email, userId, role, initials, organization, avatarUrl = null, avatarEditable = false, avatarEndpoint = "/api/profile/avatar", appearance = false }: {
  name: string;
  email: string;
  userId: string;
  role: string;
  initials: string;
  organization?: string | null;
  /** The person's own profile picture (its address), or none: the initials are shown. */
  avatarUrl?: string | null;
  /** Offer "Add / Change profile picture" in the card. */
  avatarEditable?: boolean;
  avatarEndpoint?: string;
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

  const details: { label: string; value: string; mono?: boolean }[] = [
    { label: "Role", value: role },
    { label: "User ID", value: userId, mono: true },
    ...(organization ? [{ label: "Organization", value: organization }] : []),
  ];

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
        className="rounded-full transition-colors hover:[&>*]:border-ix-accent-text/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60"
      >
        <Face url={avatarUrl} initials={initials} className="h-10 w-10 text-xs" />
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
            <Face url={avatarUrl} initials={initials} className="h-11 w-11 text-sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ix-text">{name}</p>
              <p className="truncate text-xs text-ix-muted">{email}</p>
            </div>
          </div>
          <dl className="mt-3 space-y-2 border-t border-ix-mist/10 pt-3 text-left text-xs">
            {details.map((row) => (
              <div key={row.label} className="flex items-baseline gap-1.5" data-testid="profile-detail">
                <dt className="shrink-0 font-semibold text-ix-accent-text">{row.label} :</dt>
                <dd className={`min-w-0 break-all text-ix-text ${row.mono ? "font-mono text-[11px] leading-snug" : "font-medium"}`}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {avatarEditable ? <PictureControls has={Boolean(avatarUrl)} endpoint={avatarEndpoint} /> : null}
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
