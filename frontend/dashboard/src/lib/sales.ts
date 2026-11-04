import { NextResponse } from "next/server";

// Server-side only. Talks to the Sales Service with the signed-in administrator's own session token (the HttpOnly tenant
// cookie). Nothing here ever names an organization: the Sales Service derives it from the token, so there is nothing for
// the browser to tamper with. (See docs/multi-tenancy.md.)

export function salesServiceUrl(): string {
  return (process.env.SALES_SERVICE_URL || "http://localhost:8003").replace(/\/$/, "");
}

export type SalesResult = { status: number; data: any } | null; // null = the service could not be reached

export async function salesRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  body?: unknown
): Promise<SalesResult> {
  try {
    const res = await fetch(`${salesServiceUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

// ---- types (what the Sales Service returns; no organization_id is ever included) -----------------------------------
export type Client = {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ListStatus = "draft" | "ready" | "cancelled";

export type DeliveryListSummary = {
  id: string;
  number: string;
  client: { id: string; name: string; is_active: boolean };
  external_reference: string | null;
  status: ListStatus;
  notes: string | null;
  item_count: number;
  created_by_email: string;
  created_at: string;
  updated_at: string;
};

export type ItemStock = {
  total_quantity: string;
  available_quantity: string;
  product_active: boolean;
  unit_allows_fractions: boolean;
  exceeds_available: boolean;
  shortfall: string;
};

export type DeliveryItem = {
  id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  quantity: string;
  unit: string;
  planned_warehouse_id: string | null;
  planned_warehouse_code: string | null;
  created_at: string;
  updated_at: string;
  stock: ItemStock | null;
};

export type DeliveryListDetail = DeliveryListSummary & {
  items: DeliveryItem[];
  stock_status: "ok" | "unavailable";
  items_exceeding_stock: number;
  stock_notice: string;
};

// Browser-safe constants live in sales-browser.ts (this file imports server-only code).
export { STOCK_NOTICE, STATUS_LABELS } from "@/lib/sales-browser";

// ---- reading (used by the server-rendered pages) --------------------------------------------------------------------------
export const PAGE_SIZE = 25;
type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type Paged<T> = { ok: true; items: T[]; total: number; limit: number; offset: number } | Failure;

function failure(result: SalesResult): Failure {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

async function getPaged<T>(path: string, params: URLSearchParams, token: string): Promise<Paged<T>> {
  const result = await salesRequest("GET", `${path}?${params}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, items: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

export type ClientFilters = { q: string; status: "active" | "inactive" | "all"; page: number };
export function listClients(token: string, filters: ClientFilters) {
  const params = new URLSearchParams({ status: filters.status, limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  return getPaged<Client>("/api/v1/sales/clients", params, token);
}

// Clients for pickers and filters (the service allows up to 200 per call).
export async function listClientChoices(token: string, status: "active" | "all" = "active"): Promise<Client[]> {
  const result = await getPaged<Client>("/api/v1/sales/clients", new URLSearchParams({ status, limit: "200" }), token);
  return result.ok ? result.items : [];
}

export type ListFilters = { q: string; clientId: string; status: ListStatus | ""; page: number };
export function listDeliveryLists(token: string, filters: ListFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.clientId) params.set("client_id", filters.clientId);
  if (filters.status) params.set("status", filters.status);
  return getPaged<DeliveryListSummary>("/api/v1/sales/delivery-lists", params, token);
}

export async function getDeliveryList(token: string, id: string): Promise<{ ok: true; list: DeliveryListDetail } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/delivery-lists/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, list: result.data };
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------------------------
export type SalesFailure = {
  status: number;
  message: string;
  code?: string; // e.g. "duplicate_item"
  item?: { id: string; quantity: string; unit: string; product_name: string }; // the existing line, for duplicate_item
  fieldErrors?: Record<string, string>;
};

const FIELD_NAMES: Record<string, string> = { client_id: "clientId", external_reference: "externalReference", contact_person: "contactPerson" };

export function describeSalesFailure(result: SalesResult, notFound = "Not found."): SalesFailure {
  if (!result) return { status: 503, message: "The sales service is unavailable. Please try again shortly." };
  const detail = result.data?.detail;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  switch (result.status) {
    case 401:
      return { status: 401, message: "Your session has expired. Please sign in again." };
    case 403:
      return { status: 403, message: text ?? "You do not have access to this." };
    case 404:
      return { status: 404, message: text ?? notFound };
    case 409:
      return {
        status: 409,
        message: text ?? "That change conflicts with existing data.",
        ...(detail && typeof detail === "object" && !Array.isArray(detail) ? { code: detail.code, item: detail.item } : {}),
      };
    case 422: {
      const fieldErrors: Record<string, string> = {};
      if (Array.isArray(detail)) {
        for (const entry of detail as { loc?: unknown[]; msg?: string }[]) {
          const name = String(entry.loc?.[entry.loc.length - 1]);
          const field = FIELD_NAMES[name] ?? name;
          if (!fieldErrors[field]) fieldErrors[field] = entry.msg?.replace(/^Value error, /, "") ?? "Invalid value.";
        }
      }
      return { status: 400, message: text ?? "Some values were rejected. Please check the form.", fieldErrors };
    }
    case 503:
      return { status: 503, message: text ?? "The service is temporarily unavailable. Please try again." };
    default:
      return { status: 502, message: "The request could not be completed. Please try again." };
  }
}

export function salesFailureResponse(result: SalesResult, notFound?: string) {
  const { status, message, ...rest } = describeSalesFailure(result, notFound);
  return NextResponse.json({ error: message, ...rest }, { status, headers: { "Cache-Control": "no-store" } });
}
