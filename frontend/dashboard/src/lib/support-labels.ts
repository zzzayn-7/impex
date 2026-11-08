// Help & Support: labels and styles shared by the pages (browser-safe: no server-only imports).

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

export const CATEGORY_HINTS: Record<TicketCategory, string> = {
  technical_issue: "Something is not working as expected.",
  change_request: "Ask for a change to your organization's settings, modules or account details. Nothing changes automatically: the Impex team reviews your request first.",
  account_organization: "Your account, administrators or organization details.",
  billing_subscription: "Plans, invoices and payments for your Impex subscription.",
  general_inquiry: "A question, or anything else.",
};

// How the requester sees each state.
export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open", in_progress: "In Progress", waiting_for_customer: "Waiting for You", resolved: "Resolved", closed: "Closed",
};

// How the Super Admin's inbox names the same states.
export const STAFF_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open", in_progress: "In Progress", waiting_for_customer: "Waiting for Customer", resolved: "Resolved", closed: "Closed",
};

export const STATUS_STYLE: Record<TicketStatus, string> = {
  open: "border-ix-butter/40 bg-ix-butter/15 text-ix-butter",
  in_progress: "border-ix-mist/25 bg-ix-mist/10 text-ix-mist",
  waiting_for_customer: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  resolved: "border-ix-teal/40 bg-ix-teal/15 text-ix-mist",
  closed: "border-slate-600/40 bg-slate-700/30 text-slate-400",
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const PRIORITY_STYLE: Record<TicketPriority, string> = {
  low: "border-slate-600/40 bg-slate-700/30 text-slate-300",
  normal: "border-ix-mist/25 bg-ix-mist/10 text-ix-mist",
  high: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  urgent: "border-red-500/20 bg-red-500/10 text-red-300",
};

export const SUBJECT_MAX = 150;
export const MESSAGE_MAX = 5000;

/** "2026-11-07 10:42 UTC": the same wording on the server and in the browser (no locale differences, no hydration mismatch). */
export function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
