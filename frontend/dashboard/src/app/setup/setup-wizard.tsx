"use client";

import { DragEvent, KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import { LOGO_ACCEPT, checkCompanyName, checkFullName, checkLogoFile, monogram } from "@/lib/setup-validation";

type Props = {
  mode: "full" | "profile"; // full: company + you + review.  profile: only "you" (the company was already set up)
  setupStatus: string;
  initialCompanyName: string;
  hasLogo: boolean;
  logoVersion: string | null;
  initialFullName: string;
  email: string;
};

const card = "rounded-[22px] border border-ix-mist/15 bg-ix-deep/70 p-6 shadow-[0_6px_24px_rgba(35,55,42,0.035)] sm:p-9";
const label = "block text-sm font-medium text-ix-text";
const input =
  "mt-2 block w-full rounded-xl border border-ix-mist/15 bg-ix-mist/10 px-4 py-3 text-[15px] text-ix-text placeholder-ix-muted/60 outline-none transition duration-200 focus:border-ix-accent focus:bg-ix-deep/70 focus:ring-2 focus:ring-ix-accent/25 motion-reduce:transition-none";
const primary =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-ix-action px-6 py-2.5 text-sm font-medium text-white transition duration-200 hover:bg-ix-action-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const secondary =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-ix-mist/15 bg-ix-deep/55 px-5 py-2.5 text-sm font-medium text-ix-sea transition duration-200 hover:bg-ix-sea/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/50 disabled:opacity-50 motion-reduce:transition-none";
const errorText = "mt-2 text-sm text-red-300";

const STEPS = ["Company", "You", "Review"];

/** First-time setup. The company name and the logo are saved to the Organization Service as you go, your name to the Auth Service,
 *  so a refresh or a return visit resumes with everything already entered. Nothing is "complete" until the final button succeeds and
 *  both services say so. The browser never names an organization or a user: the session decides whose setup this is. */
export default function SetupWizard(props: Props) {
  const router = useRouter();
  const fullFlow = props.mode === "full";
  const busyRef = useRef(false); // one request at a time: a double click can never submit twice
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(fullFlow && props.setupStatus === "in_progress" && props.hasLogo ? 2 : 1);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [logo, setLogo] = useState({ has: props.hasLogo, version: props.logoVersion });
  const [companyName, setCompanyName] = useState(props.initialCompanyName);
  const [fullName, setFullName] = useState(props.initialFullName);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const logoUrl = logo.has ? `/api/organization/logo?v=${encodeURIComponent(logo.version ?? "")}` : null;
  const cleanCompany = checkCompanyName(companyName);
  const cleanName = checkFullName(fullName);

  function expired() {
    router.replace("/login");
  }

  // ---- logo ----------------------------------------------------------------------------------------------------------------
  async function upload(file: File | undefined) {
    if (!file || busyRef.current) return;
    setErrors((e) => ({ ...e, logo: "" }));
    const problem = checkLogoFile(file);
    if (problem) return setErrors((e) => ({ ...e, logo: problem }));
    busyRef.current = true;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/setup/logo", { method: "POST", body: form, cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (res.status === 401) return expired();
      if (!res.ok) return setErrors((e) => ({ ...e, logo: typeof data?.error === "string" ? data.error : "That logo could not be saved. Please try again." }));
      setLogo({ has: Boolean(data?.setup?.has_logo), version: data?.setup?.logo_version ?? null });
    } catch {
      setErrors((e) => ({ ...e, logo: "Unable to reach the server. Please try again." }));
    } finally {
      busyRef.current = false;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = ""; // choosing the same file again must still fire
    }
  }

  async function removeLogo() {
    if (busyRef.current) return;
    busyRef.current = true;
    setUploading(true);
    const r = await api("/api/setup/logo", { method: "DELETE" });
    busyRef.current = false;
    setUploading(false);
    if (r.status === 401) return expired();
    if (!r.ok) return setErrors((e) => ({ ...e, logo: r.error }));
    setLogo({ has: false, version: null });
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files?.[0]);
  };
  const onZoneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.current?.click();
    }
  };

  // ---- moving between steps (each step saves what it asked for) ----------------------------------------------------------------
  async function saveCompanyAndContinue() {
    if (busyRef.current) return;
    const problems: Record<string, string> = {};
    if (!logo.has) problems.logo = "Upload your company logo to continue.";
    if (!cleanCompany.ok) problems.companyName = cleanCompany.message;
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !cleanCompany.ok) return;
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    const r = await api("/api/setup/company", { method: "PUT", ...jsonBody({ companyName: cleanCompany.value }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return expired();
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    setCompanyName(cleanCompany.value);
    setStep(2);
  }

  async function saveNameAndContinue() {
    if (busyRef.current) return;
    if (!cleanName.ok) return setErrors({ fullName: cleanName.message });
    setErrors({});
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    const r = await api("/api/setup/profile", { method: "PUT", ...jsonBody({ fullName: cleanName.value }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return expired();
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    setFullName(cleanName.value);
    setStep(3);
  }

  async function complete() {
    if (busyRef.current) return;
    const problems: Record<string, string> = {};
    if (fullFlow && !logo.has) problems.logo = "Upload your company logo to finish.";
    if (fullFlow && !cleanCompany.ok) problems.companyName = cleanCompany.message;
    if (!cleanName.ok) problems.fullName = cleanName.message;
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !cleanName.ok) {
      if (fullFlow) setStep(problems.logo || problems.companyName ? 1 : 2);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    const r = await api("/api/setup/complete", {
      method: "POST",
      ...jsonBody({ fullName: cleanName.value, ...(fullFlow && cleanCompany.ok ? { companyName: cleanCompany.value } : {}) }),
    });
    if (r.status === 401) {
      busyRef.current = false;
      return expired();
    }
    if (!r.ok) {
      busyRef.current = false;
      setBusy(false);
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    // Stay "busy" while the browser moves on: the button cannot be pressed again. The dashboard re-checks both records.
    router.replace("/");
    router.refresh();
  }

  // ---- pieces ---------------------------------------------------------------------------------------------------------------
  const Progress = () => (
    <ol aria-label="Setup progress" className="mb-8 flex items-center gap-2">
      {STEPS.map((name, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={name} aria-current={state === "current" ? "step" : undefined} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition duration-300 motion-reduce:transition-none ${
                state === "todo" ? "border border-ix-mist/15 bg-ix-deep/55 text-ix-muted" : state === "current" ? "bg-ix-action text-white" : "bg-ix-sea/15 text-ix-sea"
              }`}
            >
              {state === "done" ? "✓" : n}
            </span>
            <span className={`hidden text-sm sm:block ${state === "current" ? "font-medium text-ix-text" : "text-ix-muted"}`}>{name}</span>
            {n < STEPS.length && <span className={`h-px flex-1 transition-colors duration-300 motion-reduce:transition-none ${n < step ? "bg-ix-sage" : "bg-ix-mist/15"}`} />}
          </li>
        );
      })}
    </ol>
  );

  const LogoBadge = ({ size = "h-14 w-14" }: { size?: string }) =>
    logoUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt="Company logo" className={`${size} rounded-2xl border border-ix-mist/15 bg-ix-deep/55 object-contain p-1`} />
    ) : (
      <span className={`${size} flex items-center justify-center rounded-2xl bg-ix-sea/15 text-lg font-semibold text-ix-sea`}>{monogram(companyName)}</span>
    );

  // ---- a newly invited administrator of an already configured company: just their own profile -------------------------------------
  if (!fullFlow) {
    return (
      <section className={`${card} ix-fade`} aria-labelledby="welcome-heading">
        <div className="mb-6 flex items-center gap-4">
          <LogoBadge />
          <div>
            <p className="text-sm text-ix-muted">You are joining</p>
            <p className="text-lg font-semibold tracking-tight">{companyName}</p>
          </div>
        </div>
        <h1 id="welcome-heading" className="text-2xl font-semibold tracking-tight">Welcome, let&apos;s confirm your name</h1>
        <p className="mt-2 text-[15px] text-ix-muted">Your company workspace is already set up. Check the name that will represent you, then continue.</p>
        <div className="mt-7 space-y-5">
          <div>
            <label htmlFor="full-name" className={label}>Administrator full name</label>
            <input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} autoComplete="name" className={input} />
            {errors.fullName && <p role="alert" className={errorText}>{errors.fullName}</p>}
          </div>
          <div>
            <label htmlFor="email" className={label}>Account email</label>
            <input id="email" value={props.email} readOnly className={`${input} cursor-not-allowed text-ix-muted`} />
          </div>
        </div>
        {formError && <p role="alert" className={`${errorText} mt-4`}>{formError}</p>}
        <div className="mt-8 flex justify-end">
          <button type="button" onClick={complete} disabled={busy} className={primary}>{busy ? "Saving…" : "Continue to Dashboard"}</button>
        </div>
      </section>
    );
  }

  return (
    <section className={card} aria-label="First-time setup">
      <Progress />
      <div key={step} className="ix-fade">
        {step === 1 && (
          <>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Welcome to Impex</h1>
            <p className="mt-2 text-[15px] text-ix-muted">Let&apos;s personalize your company workspace before you get started.</p>

            <div className="mt-8">
              <span className={label} id="logo-label">Company logo</span>
              {logoUrl ? (
                <div className="mt-2 flex flex-wrap items-center gap-5 rounded-2xl border border-ix-mist/15 bg-ix-mist/10 p-5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoUrl} alt="Your company logo" className="h-24 w-24 rounded-2xl border border-ix-mist/15 bg-ix-deep/55 object-contain p-1.5" />
                  <div className="space-y-3">
                    <p className="text-sm text-ix-muted">{uploading ? "Updating…" : "Looks good. You can replace or remove it before you finish."}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} className={secondary}>Replace logo</button>
                      <button type="button" onClick={removeLogo} disabled={uploading} className={secondary}>Remove</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  aria-labelledby="logo-label"
                  aria-describedby="logo-help"
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={onZoneKey}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={`mt-2 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/50 motion-reduce:transition-none ${
                    dragging ? "border-ix-sea bg-ix-sea/15" : "border-ix-sage/60 bg-ix-mist/10 hover:bg-ix-mist/10"
                  }`}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ix-sea/15 text-xl text-ix-sea" aria-hidden="true">↑</span>
                  <span className="mt-3 text-[15px] font-medium">{uploading ? "Uploading…" : "Drag and drop your logo here, or click to browse"}</span>
                  <span id="logo-help" className="mt-1 text-sm text-ix-muted">PNG, JPEG or WebP · up to 2 MB · at least 64 × 64 pixels</span>
                </div>
              )}
              <input ref={fileInput} type="file" accept={LOGO_ACCEPT} className="sr-only" tabIndex={-1} aria-label="Choose a logo file" onChange={(e) => void upload(e.target.files?.[0])} />
              {errors.logo && <p role="alert" className={errorText}>{errors.logo}</p>}
            </div>

            <div className="mt-6">
              <label htmlFor="company-name" className={label}>Company name</label>
              <input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={120} autoComplete="organization" className={input} />
              {errors.companyName && <p role="alert" className={errorText}>{errors.companyName}</p>}
            </div>

            {formError && <p role="alert" className={`${errorText} mt-4`}>{formError}</p>}
            <div className="mt-8 flex justify-end">
              <button type="button" onClick={saveCompanyAndContinue} disabled={busy || uploading} className={primary}>{busy ? "Saving…" : "Continue"}</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Tell us about yourself</h1>
            <p className="mt-2 text-[15px] text-ix-muted">Set the name that will represent you across your workspace.</p>
            <div className="mt-8">
              <label htmlFor="full-name" className={label}>Administrator full name</label>
              <input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} autoComplete="name" className={input} />
              {errors.fullName && <p role="alert" className={errorText}>{errors.fullName}</p>}
            </div>
            {formError && <p role="alert" className={`${errorText} mt-4`}>{formError}</p>}
            <div className="mt-8 flex justify-between gap-3">
              <button type="button" onClick={() => { setErrors({}); setFormError(null); setStep(1); }} disabled={busy} className={secondary}>Back</button>
              <button type="button" onClick={saveNameAndContinue} disabled={busy} className={primary}>{busy ? "Saving…" : "Continue"}</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Review and complete</h1>
            <p className="mt-2 text-[15px] text-ix-muted">Check that everything looks right. You can go back to change anything.</p>

            <dl className="mt-7 divide-y divide-ix-mist/10 rounded-2xl border border-ix-mist/15 bg-ix-mist/10">
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-4">
                  <LogoBadge />
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ix-muted">Company</dt>
                    <dd className="text-[15px] font-medium">{companyName}</dd>
                  </div>
                </div>
                <button type="button" onClick={() => setStep(1)} className="text-sm font-medium text-ix-sea hover:underline">Edit</button>
              </div>
              <div className="flex items-center justify-between gap-4 p-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ix-muted">Administrator</dt>
                  <dd className="text-[15px] font-medium">{fullName}</dd>
                </div>
                <button type="button" onClick={() => setStep(2)} className="text-sm font-medium text-ix-sea hover:underline">Edit</button>
              </div>
              <div className="p-4">
                <dt className="text-xs uppercase tracking-wide text-ix-muted">Account email</dt>
                <dd className="text-[15px] font-medium">{props.email}</dd>
              </div>
            </dl>

            <p className="mt-7 text-sm font-medium text-ix-muted">How it will look in your dashboard</p>
            <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl bg-ix-deep px-4 py-3" aria-label="Dashboard branding preview" role="img">
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="" className="h-9 w-9 rounded-lg bg-ix-deep/55 object-contain p-0.5" />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">{monogram(companyName)}</span>
                )}
                <div className="leading-tight">
                  <p className="text-sm font-bold text-white">{companyName}</p>
                  <p className="text-xs text-slate-300">Admin Portal</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-sm text-slate-200 sm:block">{fullName}</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 bg-slate-700 text-xs font-semibold text-slate-100">{monogram(fullName)}</span>
              </div>
            </div>

            {formError && <p role="alert" className={`${errorText} mt-5`}>{formError}</p>}
            <div className="mt-8 flex flex-wrap justify-between gap-3">
              <button type="button" onClick={() => { setFormError(null); setStep(2); }} disabled={busy} className={secondary}>Back</button>
              <button type="button" onClick={complete} disabled={busy} className={primary}>{busy ? "Finishing setup…" : "Complete Setup & Enter Dashboard"}</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
