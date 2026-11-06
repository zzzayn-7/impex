// Names, colours and limits for the Support Inbox. Shared by the server pages and the browser components (no server-only imports here).

export type TicketStatus = "open" | "in_progress" | "waiting_for_customer" | "resolved" | "closed";
export type TicketCategory = "technical_issue" | "change_request" | "account_organization" | "billing_subscription" | "general_inquiry";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export const CATEGORIES = ["technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const STATUSES = ["open", "in_progress", "waiting_for_customer", "resolved", "closed"] as const;

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  technical_issue: "Technical Issue",
  change_request: "Change Request",
  account_organization: "Account & Organization",
  billing_subscription: "Billing & Subscription",
  general_inquiry: "General Inquiry",
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open", in_progress: "In Progress", waiting_for_customer: "Waiting for Customer", resolved: "Resolved", closed: "Closed",
};

export const STATUS_STYLE: Record<TicketStatus, string> = {
  open: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  in_progress: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  waiting_for_customer: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  resolved: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  closed: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const PRIORITY_STYLE: Record<TicketPriority, string> = {
  low: "border-slate-600/40 bg-slate-700/30 text-slate-300",
  normal: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  high: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  urgent: "border-red-500/20 bg-red-500/10 text-red-300",
};

/** The status moves the Support Service permits (the same table the service and the database enforce). The buttons only offer these. */
export const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["in_progress", "waiting_for_customer", "resolved", "closed"],
  in_progress: ["open", "waiting_for_customer", "resolved", "closed"],
  waiting_for_customer: ["open", "in_progress", "resolved", "closed"],
  resolved: ["open", "in_progress", "closed"],
  closed: ["open"],
};

/** What each move is called on a button. */
export const MOVE_LABELS: Record<TicketStatus, string> = {
  open: "Reopen", in_progress: "Mark In Progress", waiting_for_customer: "Waiting for Customer", resolved: "Mark Resolved", closed: "Close ticket",
};

/** The button for moving a ticket from one status to another: "Reopen" only for a ticket that was finished (Resolved or Closed). */
export function moveLabel(from: TicketStatus, to: TicketStatus): string {
  if (to === "open") return from === "closed" || from === "resolved" ? "Reopen" : "Mark Open";
  return MOVE_LABELS[to];
}

export const EVENT_LABELS: Record<string, string> = {
  created: "Ticket created", replied: "Replied", status_changed: "Status changed", priority_changed: "Priority changed",
};

export const MESSAGE_MAX = 5000;

/** "2026-11-07 10:42 UTC": the same wording on the server and in the browser (no locale differences, no hydration mismatch). */
export function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
