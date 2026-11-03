"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { EMAIL_RE } from "@/lib/organization-validation";

type Props = {
  demoMode: boolean;
  admin: {
    id: string;
    organizationId: string;
    email: string;
    fullName: string | null;
    status: "pending" | "active" | "expired";
  };
};

type Mode = "idle" | "edit" | "delete";

const secondaryButton =
  "rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium transition hover:bg-slate-800 disabled:opacity-60";

// Edit / Resend / Delete for one administrator row.
export default function AdministratorActions({ admin, demoMode }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fullName, setFullName] = useState(admin.fullName ?? "");
  const [email, setEmail] = useState(admin.email);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const canResend = demoMode || admin.status !== "active";
  const resendLabel = demoMode
    ? admin.status === "active"
      ? "Resend credentials"
      : "Send credentials"
    : "Resend invitation";

  async function call(method: "POST" | "PATCH" | "DELETE", url: string, body: unknown, okText: string) {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return false;
      }
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error ?? "That did not work. Please try again." });
        return false;
      }
      setMessage({ ok: true, text: okText });
      router.refresh(); // reload the table (ids and statuses may have changed)
      return true;
    } catch {
      setMessage({ ok: false, text: "Unable to reach the server." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const resend = () =>
    call("POST", `/api/administrators/${admin.id}/resend`, { organizationId: admin.organizationId },
      demoMode ? "Credentials sent" : "Invitation sent");

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = fullName.trim().replace(/\s+/g, " ");
    const address = email.trim().toLowerCase();
    if (name.length < 2) return setFieldError("Enter the full name (at least 2 characters).");
    if (!EMAIL_RE.test(address)) return setFieldError("Enter a valid email address.");
    setFieldError(null);

    const body: Record<string, string> = { organizationId: admin.organizationId };
    if (name !== (admin.fullName ?? "")) body.fullName = name;
    if (address !== admin.email) body.email = address;
    if (!body.fullName && !body.email) {
      setMode("idle");
      return;
    }
    if (await call("PATCH", `/api/administrators/${admin.id}`, body, "Saved")) setMode("idle");
  }

  async function remove() {
    if (await call("DELETE", `/api/administrators/${admin.id}`, { organizationId: admin.organizationId }, "Deleted")) {
      setMode("idle");
    }
  }

  if (mode === "edit") {
    const emailChanged = email.trim().toLowerCase() !== admin.email;
    return (
      <form onSubmit={save} noValidate className="w-64 space-y-2">
        <label className="block text-xs text-slate-400">
          Full name
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={busy}
            className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
        </label>
        <label className="block text-xs text-slate-400">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
            className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
        </label>
        {emailChanged && (
          <p className="text-xs text-amber-300">
            {admin.status === "active"
              ? demoMode ? "Their account moves to the new address and the sign-in details are emailed there." : "Their sign-in email changes to the new address."
              : demoMode ? "The new address gets an account and the sign-in details." : "A new invitation is sent to the new address; the old link stops working."}
          </p>
        )}
        {fieldError && <p role="alert" className="text-xs text-red-400">{fieldError}</p>}
        {message && !message.ok && <p role="alert" className="text-xs text-red-400">{message.text}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={() => { setMode("idle"); setMessage(null); setFieldError(null); setFullName(admin.fullName ?? ""); setEmail(admin.email); }}
            className={`${secondaryButton} text-slate-300`}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (mode === "delete") {
    return (
      <div className="w-64 space-y-2">
        <p className="text-xs text-slate-300">
          Delete <strong className="text-white">{admin.email}</strong>?{" "}
          {admin.status === "active"
            ? "Their account is removed and they can no longer sign in."
            : "The pending invitation is cancelled and its link stops working."}
        </p>
        {message && !message.ok && <p role="alert" className="text-xs text-red-400">{message.text}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={remove} disabled={busy} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button type="button" disabled={busy} onClick={() => { setMode("idle"); setMessage(null); }} className={`${secondaryButton} text-slate-300`}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => { setMessage(null); setMode("edit"); }} aria-label={`Edit ${admin.email}`} className={`${secondaryButton} text-slate-200`}>
          Edit
        </button>
        {canResend && (
          <button type="button" onClick={resend} disabled={busy} aria-label={`${resendLabel} to ${admin.email}`} className={`${secondaryButton} text-indigo-300`}>
            {busy ? "Sending…" : resendLabel}
          </button>
        )}
        <button type="button" onClick={() => { setMessage(null); setMode("delete"); }} aria-label={`Delete ${admin.email}`} className={`${secondaryButton} text-red-300`}>
          Delete
        </button>
      </div>
      {message && (
        <span role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
