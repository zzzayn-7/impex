"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import { passwordChecks, passwordIsStrong } from "@/lib/password-policy";

// CHOOSE A NEW PASSWORD. The current password (the temporary one from the email, after a reset), the new one twice, and the rules ticking off as the person types. The button stays off until
// the new password follows every rule, differs from the current one and matches its confirmation; the Auth Service checks all of it again. On success the portal opens.

export default function ChangePasswordForm({ email, forced }: { email: string; forced: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checks = passwordChecks(next, email);
  const matches = next !== "" && next === confirm;
  const differs = next !== "" && next !== current;
  const ready = current !== "" && passwordIsStrong(next, email) && matches && differs;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) {
        setError(data?.error ?? "The password could not be changed. Please try again.");
        setBusy(false);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Unable to reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  const type = show ? "text" : "password";
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Choose a new password">
      {error && <div role="alert" className="rounded-lg border border-red-300/30 bg-red-400/10 px-3 py-2.5 text-sm text-red-200">{error}</div>}

      <div>
        <label htmlFor="current-password" className="block text-xs font-medium text-ix-muted">{forced ? "Temporary password (from the email)" : "Current password"}</label>
        <input id="current-password" type={type} autoComplete="current-password" autoFocus disabled={busy} value={current} onChange={(e) => setCurrent(e.target.value)} className={fieldClass} />
      </div>

      <div>
        <label htmlFor="new-password" className="block text-xs font-medium text-ix-muted">New password</label>
        <input id="new-password" type={type} autoComplete="new-password" disabled={busy} value={next} onChange={(e) => setNext(e.target.value)} className={fieldClass} aria-describedby="password-rules" />
        <ul id="password-rules" className="mt-2 grid gap-1 text-xs sm:grid-cols-2" aria-label="Password rules">
          {checks.map((c) => (
            <li key={c.id} data-rule={c.id} data-ok={c.ok} className={`flex items-center gap-1.5 ${c.ok ? "text-ix-gain" : "text-ix-muted"}`}>
              <span aria-hidden="true" className="inline-block w-3 text-center">{c.ok ? "✓" : "•"}</span>
              <span>{c.label}</span>
              <span className="sr-only">{c.ok ? " (done)" : " (still needed)"}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor="confirm-password" className="block text-xs font-medium text-ix-muted">Type the new password again</label>
        <input id="confirm-password" type={type} autoComplete="new-password" disabled={busy} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={fieldClass}
          aria-invalid={confirm !== "" && !matches ? true : undefined} />
        {confirm !== "" && !matches && <p role="alert" className="mt-1.5 text-xs text-red-300">The two passwords are not the same.</p>}
        {next !== "" && current !== "" && !differs && <p role="alert" className="mt-1.5 text-xs text-red-300">The new password must be different from the current one.</p>}
      </div>

      <label className="flex items-center gap-2 text-xs text-ix-muted">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show the passwords
      </label>

      <button type="submit" disabled={!ready || busy} className={`${buttonClass.primary} w-full`}>{busy ? "Saving…" : "Save new password"}</button>
    </form>
  );
}
