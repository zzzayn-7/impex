"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { passwordChecks, passwordProblems } from "@/lib/password-policy";

type Invitation = { organizationName: string; email: string; loginUrl?: string };
type View =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "problem"; code: string; message: string }
  | { kind: "ready"; invitation: Invitation }
  | { kind: "done"; invitation: Invitation };

type FieldErrors = { fullName?: string; password?: string; confirmPassword?: string };

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1 disabled:opacity-60";

const PROBLEM_TITLES: Record<string, string> = {
  expired: "This link has expired",
  revoked: "This link is no longer valid",
  used: "This invitation was already used",
  invalid: "This link is not valid",
  missing: "No invitation found",
};

export default function ActivateForm() {
  const tokenRef = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Read the token from the URL fragment once, then remove it from the address bar so it does not
  // linger in screenshots or browser history. It is kept only in memory for this page view.
  useEffect(() => {
    if (tokenRef.current === null) {
      const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
      if (token) {
        tokenRef.current = token;
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
    const token = tokenRef.current;
    if (!token) {
      setView({ kind: "missing" });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/activate/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) {
          setView({ kind: "ready", invitation: data });
          if (typeof data?.fullName === "string" && data.fullName) setFullName(data.fullName); // name chosen by the Super Admin
        }
        else setView({ kind: "problem", code: data?.code ?? "unavailable", message: data?.message ?? "Please try again later." });
      } catch {
        if (!cancelled) setView({ kind: "problem", code: "unavailable", message: "Unable to reach the server. Check your connection and reload." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting || view.kind !== "ready") return;
    setFormError(null);

    const errors: FieldErrors = {};
    const name = fullName.trim().replace(/\s+/g, " ");
    if (name.length < 2) errors.fullName = "Enter your full name (at least 2 characters).";
    const problems = passwordProblems(password, view.invitation.email);
    if (problems.length > 0) errors.password = "Password must contain: " + problems.join(", ").toLowerCase() + ".";
    if (password !== confirmPassword) errors.confirmPassword = "The passwords do not match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/activate/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenRef.current, fullName: name, password, confirmPassword }),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 201) {
        tokenRef.current = null;
        setPassword("");
        setConfirmPassword("");
        setView({ kind: "done", invitation: { ...view.invitation, loginUrl: typeof data?.loginUrl === "string" ? data.loginUrl : undefined } });
        return;
      }
      const code = data?.code as string | undefined;
      if (code && ["expired", "revoked", "used", "invalid"].includes(code)) {
        setView({ kind: "problem", code, message: data.message });
      } else if (code === "weak_password") {
        setFieldErrors({ password: data.message });
      } else if (code === "password_mismatch") {
        setFieldErrors({ confirmPassword: data.message });
      } else if (code === "invalid_name") {
        setFieldErrors({ fullName: data.message });
      } else {
        setFormError(data?.message ?? "Activation failed. Please try again.");
      }
    } catch {
      setFormError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (view.kind === "loading") {
    return (
      <div className="flex items-center justify-center gap-3 py-6 text-sm text-slate-400" role="status">
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
        Checking your invitation…
      </div>
    );
  }

  if (view.kind === "missing" || view.kind === "problem") {
    const code = view.kind === "missing" ? "missing" : view.code;
    const message =
      view.kind === "missing"
        ? "Open the activation link from your invitation email. It contains a private code that this page needs."
        : view.message;
    return (
      <div role="alert" className="space-y-2 py-2 text-center">
        <h2 className="text-base font-semibold text-white">{PROBLEM_TITLES[code] ?? "Activation unavailable"}</h2>
        <p className="text-sm text-slate-400">{message}</p>
      </div>
    );
  }

  if (view.kind === "done") {
    return (
      <div role="status" className="space-y-3 py-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">✓</div>
        <h2 className="text-base font-semibold text-white">Your account is active</h2>
        <p className="text-sm text-slate-400">
          You are now the administrator of <strong className="text-slate-200">{view.invitation.organizationName}</strong>.
          You can now sign in with the email and password you just set.
        </p>
        {view.invitation.loginUrl && /^https?:\/\//.test(view.invitation.loginUrl) && (
          <a
            href={view.invitation.loginUrl}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            Go to organization sign in
          </a>
        )}
      </div>
    );
  }

  const checks = passwordChecks(password, view.invitation.email);
  const fieldClass = (error?: string) =>
    `${inputClass} ${error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"}`;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
          {formError}
        </div>
      )}

      <div>
        <label htmlFor="organization" className="block text-xs font-medium text-slate-400">Organization</label>
        <input id="organization" readOnly value={view.invitation.organizationName} className={`${inputClass} border-slate-800 text-slate-300`} />
      </div>
      <div>
        <label htmlFor="email" className="block text-xs font-medium text-slate-400">Invited email</label>
        <input id="email" type="email" readOnly value={view.invitation.email} autoComplete="username" className={`${inputClass} border-slate-800 text-slate-300`} />
      </div>

      <div>
        <label htmlFor="fullName" className="block text-xs font-medium text-slate-400">Full name</label>
        <input
          id="fullName" type="text" autoComplete="name" autoFocus disabled={submitting} value={fullName}
          onChange={(e) => { setFullName(e.target.value); setFieldErrors((p) => ({ ...p, fullName: undefined })); }}
          aria-invalid={fieldErrors.fullName ? true : undefined} aria-describedby={fieldErrors.fullName ? "fullName-error" : undefined}
          className={fieldClass(fieldErrors.fullName)} placeholder="Olivia Owner"
        />
        {fieldErrors.fullName && <p id="fullName-error" className="mt-1.5 text-xs text-red-400">{fieldErrors.fullName}</p>}
      </div>

      <div>
        <label htmlFor="password" className="block text-xs font-medium text-slate-400">Password</label>
        <input
          id="password" type="password" autoComplete="new-password" disabled={submitting} value={password}
          onChange={(e) => { setPassword(e.target.value); setFieldErrors((p) => ({ ...p, password: undefined })); }}
          aria-invalid={fieldErrors.password ? true : undefined} aria-describedby={fieldErrors.password ? "password-error" : "password-rules"}
          className={fieldClass(fieldErrors.password)}
        />
        {fieldErrors.password && <p id="password-error" className="mt-1.5 text-xs text-red-400">{fieldErrors.password}</p>}
        <ul id="password-rules" className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {checks.map((c) => (
            <li key={c.id} className={`text-xs ${c.ok ? "text-emerald-400" : "text-slate-500"}`}>
              <span aria-hidden="true">{c.ok ? "✓" : "○"}</span> {c.label}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-xs font-medium text-slate-400">Confirm password</label>
        <input
          id="confirmPassword" type="password" autoComplete="new-password" disabled={submitting} value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setFieldErrors((p) => ({ ...p, confirmPassword: undefined })); }}
          aria-invalid={fieldErrors.confirmPassword ? true : undefined} aria-describedby={fieldErrors.confirmPassword ? "confirmPassword-error" : undefined}
          className={fieldClass(fieldErrors.confirmPassword)}
        />
        {fieldErrors.confirmPassword && <p id="confirmPassword-error" className="mt-1.5 text-xs text-red-400">{fieldErrors.confirmPassword}</p>}
      </div>

      <button
        type="submit" disabled={submitting}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
        {submitting ? "Activating…" : "Activate account"}
      </button>
    </form>
  );
}
