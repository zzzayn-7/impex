import { NextResponse } from "next/server";

import type { TicketCategory, TicketPriority, TicketStatus } from "@/lib/support-labels";

// Server-side only. Talks to the Support Service with the signed-in Super Admin's own token (the HttpOnly cookie). The service
// verifies the Super Admin role with the Auth Service on every call; nothing here decides who may read the inbox.

export function supportServiceUrl(): string {
  return (process.env.SUPPORT_SERVICE_URL || "http://localhost:8005").replace(/\/$/, "");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SupportResult = { status: number; data: any } | null; // null = the service could not be reached

export async function supportRequest(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<SupportResult> {
  try {
    const res = await fetch(`${supportServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export type TicketMessage = { id: string; sender_role: "organization-admin" | "super-admin"; sender_name: string; body: string; created_at: string; read: boolean };
export type TicketEvent = { id: string; actor_role: string; event_type: string; old_value: string | null; new_value: string | null; created_at: string };
export type Notification = {
  id: string;
  notification_type: "new_ticket" | "customer_followup" | "staff_reply";
  recipient: string;
  delivery_status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  next_retry_at: string;
  sent_at: string | null;
  created_at: string;
};

export type TicketSummary = {
  id: string;
  ticket_number: string;
  organization_id: string | null;
  organization_name: string;
  requester_name: string;
  requester_email: string | null;
  subject: string;
  category: TicketCategory;
  category_label: string;
  priority: TicketPriority;
  status: TicketStatus;
  status_label: string;
  created_at: string;
  updated_at: string;
  last_reply_at: string;
  last_message_role: "organization-admin" | "super-admin";
  resolved_at: string | null;
  message_count: number;
  unread: boolean; // the customer wrote something nobody on the team has opened yet
  awaiting_staff: boolean | null; // the customer wrote last and the ticket is still active
};
export type TicketDetail = TicketSummary & { messages: TicketMessage[]; can_reply: boolean; events: TicketEvent[] | null; notifications: Notification[] | null };

export type InboxFilters = { q: string; status: TicketStatus | ""; category: TicketCategory | ""; priority: TicketPriority | ""; unread: boolean; page: number };
export type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type InboxPage =
  | { ok: true; items: TicketSummary[]; total: number; limit: number; offset: number; counts: Record<string, number>; unread: number }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };
export type NotificationOverview = { support_email_configured: boolean; pending: number; failed: number };

export const PAGE_SIZE = 25;

function failure(result: SupportResult): Failure {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

/** The inbox: tickets of every organization, newest activity first. Only whitelisted filters are ever forwarded. */
export async function listInbox(token: string, filters: InboxFilters): Promise<InboxPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((Math.max(1, filters.page) - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.unread) params.set("unread", "true");
  const result = await supportRequest("GET", `/api/v1/support/admin/tickets?${params}`, token);
  if (!result || result.status !== 200 || !result.data) {
    const f = failure(result);
    return { ok: false, reason: f.reason === "not-found" ? "unavailable" : f.reason };
  }
  return { ok: true, ...result.data };
}

/** Opening a ticket marks the customer's messages as read. */
export async function getTicket(token: string, id: string): Promise<{ ok: true; ticket: TicketDetail } | Failure> {
  const result = await supportRequest("GET", `/api/v1/support/admin/tickets/${id}`, token);
  if (!result || result.status !== 200 || !result.data) return failure(result);
  return { ok: true, ticket: result.data };
}

export async function getUnreadCount(token: string): Promise<number | null> {
  const result = await supportRequest("GET", "/api/v1/support/admin/summary", token);
  return result?.status === 200 && typeof result.data?.unread === "number" ? result.data.unread : null;
}

export async function getNotificationOverview(token: string): Promise<NotificationOverview | null> {
  const result = await supportRequest("GET", "/api/v1/support/admin/notifications", token);
  return result?.status === 200 && result.data ? result.data : null;
}

/** A safe, user-facing description of a failed Support Service answer. Raw service messages are shown only for the ones written for people. */
export function describeSupportFailure(result: SupportResult): { status: number; message: string; code?: string; fieldErrors?: Record<string, string> } {
  if (!result) return { status: 503, message: "Support is temporarily unavailable. Nothing was lost; please try again in a moment." };
  const detail = result.data?.detail;
  const code = typeof detail === "object" && detail ? (detail.code as string | undefined) : undefined;
  const text = typeof detail === "string" ? detail : typeof detail === "object" && detail && typeof detail.message === "string" ? (detail.message as string) : null;
  switch (result.status) {
    case 400: return { status: 400, message: text ?? "Please check what you entered.", code };
    case 401: return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403: return { status: 403, message: "Only a Super Admin can use the Support Inbox." };
    case 404: return { status: 404, message: "Ticket not found." };
    case 409: return { status: 409, message: text ?? "That change is not allowed for this ticket.", code };
    case 422: return { status: 400, message: "Please check what you entered." };
    case 429: return { status: 429, message: text ?? "Too many messages. Please wait a moment and try again." };
    case 503: return { status: 503, message: "Support is temporarily unavailable. Nothing was lost; please try again in a moment." };
    default: return { status: 502, message: "That could not be completed. Please try again." };
  }
}

export function supportFailureResponse(result: SupportResult) {
  const { status, message, code } = describeSupportFailure(result);
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}
