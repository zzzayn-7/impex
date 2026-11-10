"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api, jsonBody } from "@/lib/sales-browser";
import { newIdempotencyKey } from "@/lib/stock-validation";
import type { TicketDetail } from "@/lib/support";
import { CATEGORY_LABELS, MESSAGE_MAX, PRIORITY_LABELS, PRIORITY_STYLE, STATUS_LABELS, STATUS_STYLE } from "@/lib/support-labels";
import { useStamp } from "@/components/clock";

/** One ticket: its status, the whole conversation as bubbles, and a reply box. Message text is rendered as plain TEXT (React escapes it),
 *  never as HTML, so nothing a person wrote can run in the page. */
export default function TicketConversation({ ticket: initial, justSent = false }: { ticket: TicketDetail; justSent?: boolean }) {
  const stamp = useStamp();
  const router = useRouter();
  const [ticket, setTicket] = useState(initial);
  const keyRef = useRef(newIdempotencyKey());
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(justSent ? `Your request ${initial.ticket_number} was sent to the Impex team. You will receive an email when they reply.` : null);

  const answered = ticket.messages.some((m) => m.sender_role === "super-admin");

  async function send() {
    if (busyRef.current) return;
    setError(null);
    const body = text.trim();
    if (!body) return setError("Write your message.");
    if (body.length > MESSAGE_MAX) return setError(`Use ${MESSAGE_MAX} characters or fewer.`);
    busyRef.current = true;
    setBusy(true);
    const r = await api(`/api/support/tickets/${ticket.id}/messages`, { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ body }) });
    busyRef.current = false;
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500) keyRef.current = newIdempotencyKey(); // not accepted: the next attempt is a new message
      return setError(r.error);
    }
    keyRef.current = newIdempotencyKey(); // the next message is a new one
    setTicket(r.data.ticket);
    setText("");
    setNotice(r.data.replayed ? "That message had already been sent." : "Message sent.");
    router.refresh();
  }

  return (
    <article className="space-y-5" aria-label={ticket.ticket_number}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono text-xl font-semibold text-white">{ticket.ticket_number}</h2>
          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[ticket.status]}`}>{STATUS_LABELS[ticket.status]}</span>
          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[ticket.priority]}`}>{PRIORITY_LABELS[ticket.priority]} priority</span>
        </div>
        <p className="text-base text-slate-100">{ticket.subject}</p>
        <p className="text-xs text-slate-400">
          {CATEGORY_LABELS[ticket.category]} · opened by {ticket.requester_name} on {stamp(ticket.created_at)} · last activity {stamp(ticket.last_reply_at)}
          {ticket.resolved_at && ` · resolved ${stamp(ticket.resolved_at)}`}
        </p>
      </header>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {!answered && ticket.status !== "closed" && <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">The Impex team has not replied yet. We will email you as soon as they do; you can also come back to this page.</p>}
      {ticket.status === "waiting_for_customer" && <p role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Impex Support is waiting for your answer.</p>}
      {ticket.status === "resolved" && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">Impex Support marked this request as resolved. If it is not, reply below and it will be reopened.</p>}

      <ol className="space-y-3" aria-label="Conversation">
        {ticket.messages.map((m) => {
          const staff = m.sender_role === "super-admin";
          return (
            <li key={m.id} className={`flex ${staff ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[85%] rounded-2xl border px-4 py-3 ${staff ? "rounded-tl-sm border-emerald-500/20 bg-emerald-500/10" : "rounded-tr-sm border-indigo-500/20 bg-indigo-500/10"}`}>
                <p className="text-xs font-semibold text-slate-300">
                  {staff ? "Impex Support" : m.sender_name}
                  <span className="ml-2 font-normal text-slate-500">{stamp(m.created_at)}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-100" data-testid="message-body">{m.body}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {ticket.can_reply ? (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} aria-label="Reply" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
          <label className="block text-xs font-medium text-slate-400">
            Your reply
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={MESSAGE_MAX + 200} placeholder="Write a message to the Impex team"
              className="mt-1.5 block w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className={`text-xs ${text.length > MESSAGE_MAX ? "text-red-400" : "text-slate-500"}`}>{text.length} / {MESSAGE_MAX}</span>
            <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Sending…" : "Send reply"}</button>
          </div>
          {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        </form>
      ) : (
        <p role="note" className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
          This request is closed. If you still need help, <Link href="/support/new" className="text-indigo-300 hover:text-indigo-200">send a new request</Link>.
        </p>
      )}
    </article>
  );
}
