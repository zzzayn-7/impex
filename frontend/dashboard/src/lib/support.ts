import { NextResponse } from "next/server";

import type { TicketCategory, TicketPriority, TicketStatus } from "@/lib/support-labels";

// Server-side only. Talks to the Support Service with the signed-in administrator's own session token (the HttpOnly tenant cookie).
// Nothing here names an organization or a user: the Support Service derives both from the token, so there is nothing for the browser
// to tamper with. (See docs/multi-tenancy.md.)

export function supportServiceUrl(): string {
  return (process.env.SUPPORT_SERVICE_URL || "http://localhost:8005").replace(/\/$/, "");
}

export type SupportResult = { status: number; data: any } | null; // null = the service could not be reached

export async function supportRequest(method: "GET" | "POST", path: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<SupportResult> {
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

export type TicketSummary = {
  id: string;
  ticket_number: string;
  organization_name: string;
  requester_name: string;
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
  unread: boolean; // Impex Support replied and you have not opened it yet
};

export type TicketDetail = TicketSummary & { messages: TicketMessage[]; can_reply: boolean };

export type TicketFilters = { q: string; status: TicketStatus | ""; category: TicketCategory | ""; unread: boolean; page: number };
export type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type TicketPage =
  | { ok: true; items: TicketSummary[]; total: number; limit: number; offset: number; counts: Record<string, number>; unread: number }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };

export const PAGE_SIZE = 20;

function failure(result: SupportResult): Failure {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

export async function listTickets(token: string, filters: TicketFilters): Promise<TicketPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.unread) params.set("unread", "true");
  const result = await supportRequest("GET", `/api/v1/support/tickets?${params}`, token);
  if (!result || result.status !== 200) {
    const f = failure(result);
    return { ok: false, reason: f.reason === "not-found" ? "unavailable" : f.reason };
  }
  return { ok: true, ...result.data };
}

export async function getTicket(token: string, id: string): Promise<{ ok: true; ticket: TicketDetail } | Failure> {
  const result = await supportRequest("GET", `/api/v1/support/tickets/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, ticket: result.data };
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------------------------
export type SupportFailure = { status: number; message: string; code?: string; fieldErrors?: Record<string, string> };

const FIELD_NAMES: Record<string, string> = { subject: "subject", message: "message", body: "message", category: "category", priority: "priority" };

export function describeSupportFailure(result: SupportResult): SupportFailure {
  if (!result) return { status: 503, message: "The support service is unavailable. Nothing was lost: please try again in a moment.", code: "unavailable" };
  const detail = result.data?.detail;
  const code = typeof detail === "object" && detail && !Array.isArray(detail) && typeof detail.code === "string" ? detail.code : undefined;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again.", code: "unauthorized" };
    case 403:
      return { status: 403, message: text ?? "You do not have access to Help & Support.", code };
    case 404:
      return { status: 404, message: text ?? "Ticket not found." };
    case 409:
      return { status: 409, message: text ?? "That could not be saved.", code };
    case 429:
      return { status: 429, message: text ?? "You are sending too quickly. Please wait a few minutes and try again.", code: "rate_limited" };
    case 422: {
      const fieldErrors: Record<string, string> = {};
      if (Array.isArray(detail)) {
        for (const entry of detail as { loc?: unknown[]; msg?: string }[]) {
          const field = FIELD_NAMES[String(entry.loc?.[entry.loc.length - 1])];
          if (field && !fieldErrors[field]) fieldErrors[field] = (entry.msg ?? "Invalid value.").replace(/^Value error, /, "");
        }
      }
      return { status: 400, message: Object.values(fieldErrors)[0] ?? "Some values were rejected. Please check the form.", code: "invalid", fieldErrors };
    }
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Nothing was lost: please try again.", code: "unavailable" };
    default:
      return { status: 502, message: "That could not be completed. Please try again.", code: "service_error" };
  }
}

export function supportFailureResponse(result: SupportResult) {
  const { status, message, ...rest } = describeSupportFailure(result);
  return NextResponse.json({ error: message, ...rest }, { status, headers: { "Cache-Control": "no-store" } });
}
