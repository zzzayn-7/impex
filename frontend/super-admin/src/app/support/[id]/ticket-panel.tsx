"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api, jsonBody, newIdempotencyKey } from "@/lib/support-browser";
import type { Notification, TicketDetail } from "@/lib/support";
import {
  CATEGORY_LABELS, EVENT_LABELS, MESSAGE_MAX, moveLabel, PRIORITIES, PRIORITY_LABELS, PRIORITY_STYLE, STATUS_LABELS, STATUS_STYLE, TRANSITIONS, stamp,
  type TicketPriority, type TicketStatus,
} from "@/lib/support-labels";

export type OrganizationInfo = { id: string; name: string; slug: string; isActive: boolean; contactEmail?: string; country?: string };

const NOTIFICATION_LABELS: Record<Notification["notification_type"], string> = {
  new_ticket: "New ticket → support team", customer_followup: "Customer follow-up → support team", staff_reply: "Reply → requester",
};
const DELIVERY_LABELS: Record<Notification["delivery_status"], string> = { pending: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Failed" };
const DELIVERY_STYLE: Record<Notification["delivery_status"], string> = {
  pending: "text-amber-300", sending: "text-ix-mist", sent: "text-ix-butter", failed: "text-red-400",
};

function describeEvent(e: NonNullable<TicketDetail["events"]>[number]): string {
  const label = EVENT_LABELS[e.event_type] ?? e.event_type;
  const name = (v: string | null) => (v && (STATUS_LABELS as Record<string, string>)[v]) || (v && (PRIORITY_LABELS as Record<string, string>)[v]) || v || "";
  if (e.event_type === "status_changed" || e.event_type === "priority_changed") return `${label}: ${name(e.old_value)} → ${name(e.new_value)}`;
  return label;
}

/** One ticket for the Super Admin: the organization and requester, the whole conversation, the reply box, status and priority controls,
 *  the email notification records (with retry) and the audit trail. Message text is rendered as plain TEXT, never HTML. */
export default function TicketPanel({ initial, organization }: { initial: TicketDetail; organization: OrganizationInfo | null }) {
  const router = useRouter();
  const [ticket, setTicket] = useState(initial);
  const keyRef = useRef(newIdempotencyKey());
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [after, setAfter] = useState<TicketStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  const closed = ticket.status === "closed";
  const activeStatus = ticket.status === "open" || ticket.status === "in_progress" || ticket.status === "waiting_for_customer";
  // After a reply the ticket normally waits for the customer. Other choices are limited to the moves the service allows.
  const afterOptions = TRANSITIONS[ticket.status];

  async function send() {
    if (busyRef.current) return;
    setError(null);
    setNotice(null);
    const body = text.trim();
    if (!body) return setError("Write your reply.");
    if (body.length > MESSAGE_MAX) return setError(`Use ${MESSAGE_MAX} characters or fewer.`);
    busyRef.current = true;
    setBusy(true);
    const r = await api(`/api/support/tickets/${ticket.id}/messages`, { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ body, ...(after ? { status: after } : {}) }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey(); // not accepted: the next attempt is a new reply
      return setError(r.error);
    }
    keyRef.current = newIdempotencyKey(); // the next reply is a new one
    setTicket(r.data.ticket);
    setText("");
    setAfter("");
    setNotice(r.data.replayed ? "That reply had already been sent." : "Reply sent. The requester has been notified by email (see Email notifications below).");
    router.refresh();
  }

  async function change(patch: { status?: TicketStatus; priority?: TicketPriority }) {
    if (changing) return;
    setChanging(true);
    setControlError(null);
    setNotice(null);
    const r = await api(`/api/support/tickets/${ticket.id}`, { method: "PATCH", ...jsonBody(patch) });
    setChanging(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setControlError(r.error);
    setTicket(r.data.ticket);
    setNotice(patch.status ? `Status changed to ${STATUS_LABELS[patch.status]}.` : "Priority updated.");
    router.refresh();
  }

  async function retry(id: string) {
    setControlError(null);
    const r = await api(`/api/support/notifications/${id}/retry`, { method: "POST" });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setControlError(r.error);
    setTicket((t) => ({ ...t, notifications: (t.notifications ?? []).map((n) => (n.id === id ? { ...n, ...r.data.notification } : n)) }));
    setNotice("Another delivery attempt has been scheduled.");
  }

  return (
    <article className="space-y-6" aria-label={ticket.ticket_number}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono text-xl font-semibold text-white">{ticket.ticket_number}</h2>
          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[ticket.status]}`}>{STATUS_LABELS[ticket.status]}</span>
          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[ticket.priority]}`}>{PRIORITY_LABELS[ticket.priority]} priority</span>
        </div>
        <p className="text-base text-slate-100">{ticket.subject}</p>
        <p className="text-xs text-slate-400">
          {CATEGORY_LABELS[ticket.category]} · submitted {stamp(ticket.created_at)} · last activity {stamp(ticket.last_reply_at)}
          {ticket.resolved_at && ` · resolved ${stamp(ticket.resolved_at)}`}
        </p>
        {ticket.category === "change_request" && (
          <p role="note" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Change Request: nothing was changed automatically. Review it, make the change yourself if it is appropriate, then reply.
          </p>
        )}
      </header>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {controlError && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{controlError}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <ol className="space-y-3" aria-label="Conversation">
            {ticket.messages.map((m) => {
              const staff = m.sender_role === "super-admin";
              return (
                <li key={m.id} className={`flex ${staff ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl border px-4 py-3 ${staff ? "rounded-tr-sm border-ix-butter/25 bg-ix-butter/10" : "rounded-tl-sm border-ix-mist/15 bg-ix-mist/[0.06]"}`}>
                    <p className="text-xs font-semibold text-slate-300">
                      {staff ? `${m.sender_name} (Impex Support)` : m.sender_name}
                      <span className="ml-2 font-normal text-slate-500">{stamp(m.created_at)}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-100" data-testid="message-body">{m.body}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          {closed ? (
            <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
              <span>This ticket is closed. Reopen it to reply.</span>
              <button type="button" disabled={changing} onClick={() => void change({ status: "open" })} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">Reopen ticket</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void send(); }} aria-label="Reply" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
              <label className="block text-xs font-medium text-slate-400">
                Your reply to {ticket.requester_name}
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={MESSAGE_MAX + 200} placeholder="Write a reply. It is saved here and emailed to the requester."
                  className="mt-1.5 block w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
              </label>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <label className="text-xs font-medium text-slate-400">
                  After sending
                  <select value={after} onChange={(e) => setAfter(e.target.value as TicketStatus | "")} className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
                    <option value="">{activeStatus ? "Waiting for Customer (default)" : `Keep ${STATUS_LABELS[ticket.status]}`}</option>
                    {afterOptions.filter((s) => s !== "waiting_for_customer" || !activeStatus).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                  </select>
                </label>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${text.length > MESSAGE_MAX ? "text-red-400" : "text-slate-500"}`}>{text.length} / {MESSAGE_MAX}</span>
                  <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Sending…" : "Send reply"}</button>
                </div>
              </div>
              {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
            </form>
          )}
        </div>

        <aside className="space-y-4" aria-label="Ticket details">
          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4" aria-label="Organization and requester">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Organization</h3>
            <p className="text-sm font-medium text-white">{organization?.name ?? ticket.organization_name}</p>
            {organization && (
              <p className="text-xs text-slate-400">
                {organization.slug}{organization.country ? ` · ${organization.country}` : ""} · {organization.isActive ? "Active" : <span className="text-red-400">Inactive</span>}
              </p>
            )}
            {organization?.contactEmail && <p className="text-xs text-slate-400">Organization contact: <a href={`mailto:${organization.contactEmail}`} className="text-indigo-300 hover:text-indigo-200">{organization.contactEmail}</a></p>}
            <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Requester</h3>
            <p className="text-sm text-slate-200">{ticket.requester_name}</p>
            {ticket.requester_email && <p className="break-all text-xs"><a href={`mailto:${ticket.requester_email}`} className="text-indigo-300 hover:text-indigo-200">{ticket.requester_email}</a></p>}
            <p className="pt-1"><Link href="/organizations" className="text-xs text-indigo-300 hover:text-indigo-200">Open Organizations →</Link></p>
          </section>

          <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4" aria-label="Status and priority">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</h3>
            <div className="flex flex-wrap gap-2">
              {TRANSITIONS[ticket.status].map((s) => (
                <button key={s} type="button" disabled={changing} onClick={() => void change({ status: s })}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">{moveLabel(ticket.status, s)}</button>
              ))}
            </div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Priority
              <select value={ticket.priority} disabled={changing} onChange={(e) => void change({ priority: e.target.value as TicketPriority })}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white outline-none focus:border-indigo-500 disabled:opacity-60">
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
              </select>
            </label>
          </section>

          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4" aria-label="Email notifications">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email notifications</h3>
            {!ticket.notifications || ticket.notifications.length === 0 ? (
              <p className="text-xs text-slate-500">No notification emails recorded.</p>
            ) : (
              <ul className="space-y-2">
                {ticket.notifications.map((n) => (
                  <li key={n.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs">
                    <p className="text-slate-300">{NOTIFICATION_LABELS[n.notification_type]}</p>
                    <p className={`font-medium ${DELIVERY_STYLE[n.delivery_status]}`}>
                      {DELIVERY_LABELS[n.delivery_status]}{n.attempts > 0 ? ` · ${n.attempts} ${n.attempts === 1 ? "attempt" : "attempts"}` : ""}
                      {n.sent_at ? ` · ${stamp(n.sent_at)}` : ""}
                    </p>
                    {n.last_error && n.delivery_status !== "sent" && <p className="break-words text-slate-500">{n.last_error}</p>}
                    {n.delivery_status === "failed" && (
                      <button type="button" onClick={() => void retry(n.id)} className="mt-1 rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800">Try again</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/30 p-4" aria-label="Activity">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Activity</h3>
            {!ticket.events || ticket.events.length === 0 ? (
              <p className="text-xs text-slate-500">No activity recorded.</p>
            ) : (
              <ol className="space-y-1.5 text-xs text-slate-400">
                {ticket.events.map((e) => (
                  <li key={e.id}>
                    <span className="text-slate-300">{describeEvent(e)}</span>
                    <span className="block text-slate-500">{e.actor_role === "super-admin" ? "Support" : "Customer"} · {stamp(e.created_at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </article>
  );
}
