"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import { newIdempotencyKey } from "@/lib/stock-validation";
import { CATEGORIES, CATEGORY_HINTS, CATEGORY_LABELS, MESSAGE_MAX, PRIORITIES, PRIORITY_LABELS, SUBJECT_MAX, type TicketCategory, type TicketPriority } from "@/lib/support-labels";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

/** Open a support ticket. The Idempotency-Key is made once per attempt: pressing Send twice, or retrying after a lost connection, can
 *  never create two tickets. A refused request gets a new key next time (it was not accepted); a lost connection keeps the same one. */
export default function NewTicketForm() {
  const router = useRouter();
  const keyRef = useRef(newIdempotencyKey());
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<TicketCategory | "">("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function validate(): boolean {
    const problems: Record<string, string> = {};
    if (subject.trim().length < 3) problems.subject = "Write a short subject (at least 3 characters).";
    if (!category) problems.category = "Choose a category.";
    if (!message.trim()) problems.message = "Describe your request.";
    else if (message.trim().length > MESSAGE_MAX) problems.message = `Use ${MESSAGE_MAX} characters or fewer.`;
    setErrors(problems);
    return Object.keys(problems).length === 0;
  }

  async function submit() {
    if (busyRef.current) return;
    setFormError(null);
    if (!validate()) return;
    busyRef.current = true;
    setBusy(true);
    const r = await api("/api/support/tickets", { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ subject, category, priority, message }) });
    if (r.status === 401) {
      busyRef.current = false;
      return router.replace("/login");
    }
    if (!r.ok) {
      busyRef.current = false;
      setBusy(false);
      if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey(); // that request was not accepted: the next attempt is a new one
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    // Stay "busy" while the browser moves on: the button cannot be pressed again.
    router.push(`/support/${r.data.ticket.id}?sent=1`);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="New support request" className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-6">
      <label className="block text-xs font-medium text-slate-400">
        Subject
        <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={SUBJECT_MAX} placeholder="A short summary" className={fieldClass} />
        {errors.subject && <span role="alert" className="mt-1 block text-red-400">{errors.subject}</span>}
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-400">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)} className={fieldClass}>
            <option value="">Choose a category…</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
          {errors.category && <span role="alert" className="mt-1 block text-red-400">{errors.category}</span>}
        </label>
        <label className="block text-xs font-medium text-slate-400">
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className={fieldClass}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
        </label>
      </div>
      {category && <p role="note" className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-400">{CATEGORY_HINTS[category]}</p>}

      <label className="block text-xs font-medium text-slate-400">
        Message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8} maxLength={MESSAGE_MAX + 200} placeholder="Describe what happened, or what you need, in as much detail as you can." className={`${fieldClass} resize-y`} />
        <span className={`mt-1 flex justify-between ${message.length > MESSAGE_MAX ? "text-red-400" : "text-slate-500"}`}>
          <span>{errors.message ? <span role="alert" className="text-red-400">{errors.message}</span> : "Plain text. Never include passwords."}</span>
          <span>{message.length} / {MESSAGE_MAX}</span>
        </span>
      </label>

      {formError && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{formError}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Sending…" : "Send request"}</button>
      </div>
    </form>
  );
}
