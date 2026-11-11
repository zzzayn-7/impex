"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { useThemeOptional } from "@/components/theme/theme-provider";

// The signed-in administrator in the header: just the round avatar (their profile picture, or their initials). Hovering it only blurs it a little; CLICKING it opens a small
// dark-glass card (Escape, a click elsewhere or clicking the avatar again closes it). The card shows, in this order: the profile picture centred in its frame with a small edit
// icon beside it, then the name and the e-mail, then the other details as "Label : value" lines, labels in the accent colour, all left aligned.
// With `avatarEditable` the edit icon asks whether to TAKE a picture (the camera) or CHOOSE one from the files (and, when there is one, to remove it).
// The card is always in the page but invisible while closed (visibility hidden), so it is neither seen nor read out until it opens.
// This file is an identical copy in both portals (like the tooltip): keep them in sync.

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

function Face({ url, initials, className, blurOnHover = false }: { url?: string | null; initials: string; className: string; blurOnHover?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const base = `grid shrink-0 place-items-center overflow-hidden rounded-full border border-ix-accent-text/30 bg-ix-slate/60 font-semibold text-ix-accent-text ${blurOnHover ? "transition duration-200 group-hover:blur-[2px] group-hover:opacity-80 motion-reduce:transition-none" : ""}`;
  return url && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" onError={() => setBroken(true)} data-testid="profile-picture" className={`${base} object-cover ${className}`} />
  ) : (
    <span aria-hidden="true" className={`${base} ${className}`}>{initials}</span>
  );
}

const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const Pencil = () => <svg {...icon} className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
const Camera = () => <svg {...icon} className="h-4 w-4"><path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3Z" /><circle cx="12" cy="13" r="3.5" /></svg>;
const Folder = () => <svg {...icon} className="h-4 w-4"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
const Trash = () => <svg {...icon} className="h-4 w-4"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 14h10l1-14" /></svg>;

/** Take a picture with the device's camera: live preview, one shot, a look at it, then "Use this photo" (or retake). Everything stays in the browser until it is used. */
function CameraDialog({ onUse, onClose }: { onUse: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shot, setShot] = useState<{ url: string; blob: Blob } | null>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("The camera is not available here. Browsers only allow it on secure (https) pages and on this computer; choose a picture from your files instead.");
        return;
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        if (cancelled) return media.getTracks().forEach((track) => track.stop());
        stream.current = media;
        if (video.current) video.current.srcObject = media;
      } catch {
        if (!cancelled) setProblem("The camera could not be opened. Allow camera access in your browser, or choose a picture from your files instead.");
      }
    }
    void start();
    return () => { cancelled = true; stream.current?.getTracks().forEach((track) => track.stop()); };
  }, []);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  function capture() {
    const el = video.current;
    if (!el || !el.videoWidth) return;
    const side = Math.min(el.videoWidth, el.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(512, side);
    canvas.getContext("2d")?.drawImage(el, (el.videoWidth - side) / 2, (el.videoHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => { if (blob) setShot({ url: URL.createObjectURL(blob), blob }); }, "image/jpeg", 0.9);
  }

  const button = "rounded-lg border border-ix-mist/15 bg-ix-mist/5 px-3 py-2 text-xs font-medium text-ix-text transition-colors hover:bg-ix-mist/10 hover:text-ix-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60";
  return (
    <div
      data-profile-dialog=""
      className="ix-overlay-in fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="ix-menu ix-dialog-in w-full max-w-xs p-4 text-center">
        <h3 id={titleId} className="text-sm font-semibold text-ix-text">Take a picture</h3>
        {problem ? (
          <p role="alert" className="mt-3 text-xs text-ix-muted">{problem}</p>
        ) : (
          <div className="relative mx-auto mt-3 aspect-square w-56 overflow-hidden rounded-full border border-ix-accent-text/30 bg-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {shot ? <img src={shot.url} alt="Your new profile picture" className="h-full w-full object-cover" /> : <video ref={video} autoPlay playsInline muted aria-label="Camera preview" className="h-full w-full -scale-x-100 object-cover" />}
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {!problem && !shot && <button type="button" onClick={capture} className={button} autoFocus>Take photo</button>}
          {shot && <button type="button" onClick={() => onUse(new File([shot.blob], "profile-picture.jpg", { type: "image/jpeg" }))} className={button} autoFocus>Use this photo</button>}
          {shot && <button type="button" onClick={() => setShot(null)} className={button}>Retake</button>}
          <button type="button" onClick={onClose} className={button}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** The picture in its frame, with the edit icon beside it. Only rendered where the portal offers editing (it needs the router, to show the new picture). */
function PictureEditor({ url, initials, endpoint }: { url: string | null; initials: string; endpoint: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMenu(false); } };
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.("[data-picture-editor]")) setMenu(false); };
    document.addEventListener("keydown", close, true);
    document.addEventListener("mousedown", away);
    return () => { document.removeEventListener("keydown", close, true); document.removeEventListener("mousedown", away); };
  }, [menu]);

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

  function upload(file: File | undefined) {
    if (!file) return;
    if (!TYPES.includes(file.type)) return setMessage({ ok: false, text: "Use a PNG, JPEG or WebP picture." });
    if (file.size > MAX_BYTES) return setMessage({ ok: false, text: "The picture must be 2 MB or smaller." });
    const form = new FormData();
    form.set("file", file, "profile-picture");
    void send({ method: "PUT", body: form }, "Profile picture saved.");
  }

  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-ix-text transition-colors hover:bg-ix-mist/10 hover:text-ix-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:opacity-50";
  return (
    <div data-picture-editor="" className="relative mx-auto w-fit">
      <Face url={url} initials={initials} className="h-24 w-24 text-2xl" />
      <button
        type="button" aria-label="Edit profile picture" aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined} disabled={busy}
        onClick={() => setMenu((was) => !was)}
        className="absolute -right-1 bottom-1 grid h-8 w-8 place-items-center rounded-full border border-ix-accent-text/40 bg-ix-deep text-ix-accent-text shadow-md transition-colors hover:bg-ix-slate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:opacity-60"
      >
        <Pencil />
      </button>
      <input
        ref={input} type="file" accept={TYPES.join(",")} hidden aria-label="Choose a profile picture" data-testid="profile-picture-input"
        onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ""; }}
      />
      {menu && (
        <div id={menuId} role="menu" aria-label="Profile picture" className="ix-pop absolute left-1/2 top-full z-10 mt-2 w-48 -translate-x-1/2 rounded-xl border border-ix-mist/15 bg-ix-deep p-1 text-left shadow-xl shadow-black/30">
          <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); setMessage(null); setCamera(true); }}><Camera />Take a picture</button>
          <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); input.current?.click(); }}><Folder />Choose from files</button>
          {url && <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); void send({ method: "DELETE" }, "Profile picture removed."); }}><Trash />Remove picture</button>}
        </div>
      )}
      {/* in the page itself, not inside the card: the card has its own transform, which would make "fixed" mean "fixed to the card" */}
      {camera && createPortal(<CameraDialog onClose={() => setCamera(false)} onUse={(file) => { setCamera(false); upload(file); }} />, document.body)}
      {busy && <p role="status" className="mt-2 text-center text-xs text-ix-muted">Saving…</p>}
      {message && <p role={message.ok ? "status" : "alert"} className={`mt-2 text-center text-xs ${message.ok ? "text-ix-accent-text" : "text-red-300"}`}>{message.text}</p>}
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
  /** Offer the edit icon (take a picture / choose from files / remove) beside the picture in the card. */
  avatarEditable?: boolean;
  avatarEndpoint?: string;
  /** Offer "Customize Theme" in the card (it opens the same customizer as the header's palette button). */
  appearance?: boolean;
}) {
  const theme = useThemeOptional();
  const cardId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (wrap.current && !wrap.current.contains(event.target as Node) && !(event.target as Element).closest?.("[data-profile-dialog]")) setOpen(false); };
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
    <div ref={wrap} className="relative">
      {/* hovering only blurs the picture a little; the card opens on a CLICK */}
      <button
        type="button"
        aria-label={`Account: ${name}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen((was) => !was)}
        className="group rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60"
      >
        <Face url={avatarUrl} initials={initials} className="h-10 w-10 text-xs" blurOnHover />
      </button>
      {/* pt-2 keeps the card attached to the avatar */}
      <div
        id={cardId}
        role="group"
        aria-label="Account details"
        className={`absolute right-0 top-full z-50 w-[min(18rem,calc(100vw-2rem))] pt-2 transition duration-150 motion-reduce:transition-none ${open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-1 opacity-0"}`}
      >
        <div className="ix-menu p-4 text-left">
          <div className="text-center">
            {avatarEditable ? <PictureEditor url={avatarUrl} initials={initials} endpoint={avatarEndpoint} /> : <Face url={avatarUrl} initials={initials} className="mx-auto h-24 w-24 text-2xl" />}
            <p className="mt-3 truncate text-sm font-semibold text-ix-text">{name}</p>
            <p className="truncate text-xs text-ix-muted">{email}</p>
          </div>
          <dl className="mt-4 space-y-2 border-t border-ix-mist/10 pt-3 text-left text-xs">
            {details.map((row) => (
              <div key={row.label} className="flex items-baseline gap-1.5" data-testid="profile-detail">
                <dt className="shrink-0 font-semibold text-ix-accent-text">{row.label} :</dt>
                <dd className={`min-w-0 break-all text-ix-text ${row.mono ? "font-mono text-[11px] leading-snug" : "font-medium"}`}>{row.value}</dd>
              </div>
            ))}
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
