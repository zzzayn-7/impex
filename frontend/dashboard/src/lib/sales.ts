import { NextResponse } from "next/server";

// Server-side only. Talks to the Sales Service with the signed-in administrator's own session token (the HttpOnly tenant
// cookie). Nothing here ever names an organization: the Sales Service derives it from the token, so there is nothing for
// the browser to tamper with. (See docs/multi-tenancy.md.)

export function salesServiceUrl(): string {
  return (process.env.SALES_SERVICE_URL || "http://localhost:8003").replace(/\/$/, "");
}

export type SalesResult = { status: number; data: any } | null; // null = the service could not be reached

export async function salesRequest(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<SalesResult> {
  try {
    const res = await fetch(`${salesServiceUrl()}${path}`, {
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

export type ListStatus = "draft" | "ready" | "partially_dispatched" | "dispatched" | "cancelled";

// How a delivery list relates to stock booking: booked (its order holds the reservation), pending (not confirmed yet - never treated as booked),
// unbooked / unbooked_partial (an OLDER list made before reservations existed), draft (nothing is booked until it is marked Ready), none.
export type BookingState = "booked" | "pending" | "unbooked" | "unbooked_partial" | "draft" | "none";

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
  order_id?: string | null;
  order_number?: string | null;
  order_status?: string | null;
  reservation_status?: string | null;
  booking_state?: BookingState;
};

export type ItemStock = {
  total_quantity: string; // PHYSICAL stock on hand
  reserved_quantity?: string; // committed to sales orders
  available_quantity?: string; // on hand minus reserved
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
  created_at: string;
  updated_at: string;
  stock: ItemStock | null;
  // Dispatch progress: only CONFIRMED dispatches count as dispatched; a dispatch being posted is pending (reserved).
  dispatched_quantity?: string;
  pending_quantity?: string;
  remaining_quantity?: string;
};

export type DispatchStatus = "draft" | "posting" | "confirmed" | "cancelled";

export type DispatchSummary = {
  id: string;
  number: string;
  status: DispatchStatus;
  delivery_list: { id: string; number: string; status: ListStatus };
  client: { id: string; name: string; is_active: boolean };
  dispatch_date: string;
  tracking_reference: string | null;
  line_count: number;
  created_by_email: string;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by_email: string | null;
  cancelled_at: string | null;
  cancelled_by_email: string | null;
  updated_at: string;
};

export type DispatchLine = {
  id: string;
  delivery_list_item_id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  requested_quantity: string;
  dispatched_elsewhere_quantity: string;
  pending_elsewhere_quantity: string;
  dispatchable_quantity: string;
  quantity: string;
  inventory_movement_id: string | null;
  available_quantity: string | null;
};

export type DispatchDetail = DispatchSummary & {
  delivery_address: string | null;
  transport_details: string | null;
  notes: string | null;
  lines: DispatchLine[];
  posting: { attempts: number; started_at: string | null; last_attempt_at: string | null; last_error: string | null };
  inventory_operation_id: string | null;
  editable: boolean;
  stock_status: "ok" | "unavailable" | "not-needed";
  lines_exceeding_stock: number;
  stock_notice: string;
};

// ---- sales orders (Step 23) ---------------------------------------------------------------------------------------------------
export type OrderStatus = "pending_reservation" | "active" | "delivered" | "closed" | "cancelled" | "failed";
export type ReservationStatus = "pending" | "reserved" | "updating" | "consumed" | "released" | "none";

export type OrderSummary = {
  id: string;
  number: string;
  client: { id: string; name: string; is_active: boolean };
  delivery_list: { id: string; number: string; status: ListStatus };
  status: OrderStatus;
  reservation_status: ReservationStatus;
  origin: "order" | "list";
  version: number;
  product_count: number;
  /** What the order is worth at the catalog's current selling prices (exact decimal string) and its currency. Null when it cannot be totalled: products in two
   *  currencies, a product that is gone, or the Inventory Service could not be asked. Only the order LIST carries it. */
  total_amount?: string | null;
  currency_code?: string | null;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  history_expires_at: string | null;
  pending_action: string | null;
  last_error: string | null;
  notes: string | null;
};

export type OrderLine = {
  id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  unit_allows_fractions: boolean | null;
  ordered_quantity: string;
  dispatched_quantity: string;
  pending_quantity: string;
  remaining_quantity: string;
  stock: { total_quantity: string; reserved_quantity: string; available_quantity: string; reserved_for_order: string; product_active: boolean } | null;
};

export type OrderDetail = OrderSummary & {
  lines: OrderLine[];
  stock_status: "ok" | "unavailable";
  dispatches: DispatchSummary[];
  can_edit: boolean;
  edit_blocked_reason: string | null;
  can_cancel: boolean;
  can_cancel_remaining: boolean;
  cancel_blocked_reason: string | null;
  can_dispatch: boolean;
  message: string | null;
};

export type DeliveryListDetail = DeliveryListSummary & {
  items: DeliveryItem[];
  stock_status: "ok" | "unavailable";
  items_exceeding_stock: number;
  stock_notice: string;
  dispatches?: DispatchSummary[];
  can_dispatch?: boolean;
};

// ---- invoices and payments (Step 17B). Money is ALWAYS a string with 4 decimals, exactly as stored; nothing is converted. -----------
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void";
export type PaymentMethod = "cash" | "bank_transfer" | "cheque" | "card" | "mobile_wallet" | "other";
export type PaymentStatusFilter = "unpaid" | "partial" | "paid" | "overdue";

export type InvoiceSummary = {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  client: { id: string; name: string; is_active: boolean };
  delivery_list: { id: string; number: string; status: ListStatus } | null;
  invoice_date: string;
  due_date: string;
  currency_code: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  total: string;
  paid_total: string;
  outstanding: string;
  overdue: boolean;
  line_count: number;
  created_by_email: string;
  issued_at: string | null;
  issued_by_email: string | null;
  voided_at: string | null;
  updated_at: string;
};

export type InvoiceLineAllocation = { dispatch_line_id: string; dispatch_id: string; dispatch_number: string; quantity: string };

export type InvoiceLine = {
  id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  quantity: string;
  unit_price: string;
  discount_amount: string;
  tax_rate: string;
  tax_label: string | null;
  line_subtotal: string;
  line_net: string;
  line_tax: string;
  line_total: string;
  allocations: InvoiceLineAllocation[];
};

export type Payment = {
  id: string;
  invoice_id: string;
  kind: "payment" | "reversal";
  reverses_payment_id: string | null;
  payment_date: string;
  amount: string;
  currency_code: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  recorded_by_email: string;
  created_at: string;
  reversed: boolean;
};

export type InvoiceDetail = InvoiceSummary & {
  seller_name: string | null;
  client_name: string | null;
  client_address: string | null;
  notes: string | null;
  void_reason: string | null;
  lines: InvoiceLine[];
  payments: Payment[];
  editable: boolean;
  can_issue: boolean;
  can_void: boolean;
  can_record_payment: boolean;
  disclaimer: string;
};

export type BillableLine = {
  dispatch_line_id: string;
  dispatch_id: string;
  dispatch_number: string;
  dispatch_date: string;
  delivery_list: { id: string; number: string; status: ListStatus };
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  dispatched_quantity: string;
  invoiced_quantity: string;
  in_drafts_quantity: string;
  remaining_quantity: string;
};

export type AccountBalance = { currency_code: string; invoiced: string; paid: string; outstanding: string; overdue: string };
export type ClientAccount = {
  client: { id: string; name: string; is_active: boolean };
  balances: AccountBalance[];
  invoices: InvoiceSummary[];
  payments: (Payment & { invoice_number: string })[];
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

export type OrderView = "active" | "delivered";

/** Orders still to be delivered (active), or completed within the last 24 hours (delivered). The 24-hour cutoff is applied by the Sales Service. */
export function listOrders(token: string, view: OrderView, q = "") {
  const params = new URLSearchParams({ view, limit: "100", offset: "0" });
  if (q) params.set("q", q);
  return getPaged<OrderSummary>("/api/v1/sales/orders", params, token);
}

/** Delivery lists that do NOT belong to a sales order: drafts, and older Ready lists made before stock reservations existed. */
export function listUnlinkedLists(token: string) {
  const params = new URLSearchParams({ has_order: "false", limit: "100", offset: "0" });
  return getPaged<DeliveryListSummary>("/api/v1/sales/delivery-lists", params, token);
}

export async function getOrder(token: string, id: string): Promise<{ ok: true; order: OrderDetail } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/orders/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, order: result.data };
}

export async function getDeliveryList(token: string, id: string): Promise<{ ok: true; list: DeliveryListDetail } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/delivery-lists/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, list: result.data };
}

export type DispatchFilters = { q: string; status: DispatchStatus | ""; clientId: string; listId: string; dateFrom: string; dateTo: string; page: number };
export function listDispatches(token: string, filters: DispatchFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.clientId) params.set("client_id", filters.clientId);
  if (filters.listId) params.set("delivery_list_id", filters.listId);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return getPaged<DispatchSummary>("/api/v1/sales/dispatches", params, token);
}

export async function getDispatch(token: string, id: string): Promise<{ ok: true; dispatch: DispatchDetail } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/dispatches/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, dispatch: result.data };
}

export type InvoiceFilters = { q: string; status: InvoiceStatus | ""; paymentStatus: PaymentStatusFilter | ""; clientId: string; dateFrom: string; dateTo: string; page: number };
export function listInvoices(token: string, filters: InvoiceFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.paymentStatus) params.set("payment_status", filters.paymentStatus);
  if (filters.clientId) params.set("client_id", filters.clientId);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return getPaged<InvoiceSummary>("/api/v1/sales/invoices", params, token);
}

export async function getInvoice(token: string, id: string): Promise<{ ok: true; invoice: InvoiceDetail } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/invoices/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, invoice: result.data };
}

export async function listBillableLines(token: string, clientId: string): Promise<{ ok: true; lines: BillableLine[] } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/billable-lines?${new URLSearchParams({ client_id: clientId })}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, lines: result.data };
}

export async function getClientAccount(token: string, clientId: string): Promise<{ ok: true; account: ClientAccount } | Failure> {
  const result = await salesRequest("GET", `/api/v1/sales/clients/${clientId}/account`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, account: result.data };
}

/** The invoice PDF as raw bytes, for the browser to download. null = the service could not be reached. */
export async function salesBinary(path: string, token: string): Promise<{ status: number; body: ArrayBuffer | null; contentDisposition: string | null; data: any } | null> {
  try {
    const res = await fetch(`${salesServiceUrl()}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (res.status !== 200) return { status: res.status, body: null, contentDisposition: null, data: await res.json().catch(() => null) };
    return { status: 200, body: await res.arrayBuffer(), contentDisposition: res.headers.get("content-disposition"), data: null };
  } catch {
    return null;
  }
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------------------------
export type SalesFailure = {
  status: number;
  message: string;
  code?: string; // e.g. "duplicate_item"
  item?: { id: string; quantity: string; unit: string; product_name: string }; // the existing line, for duplicate_item
  fieldErrors?: Record<string, string>;
};

const FIELD_NAMES: Record<string, string> = {
  client_id: "clientId", external_reference: "externalReference", contact_person: "contactPerson", delivery_list_id: "deliveryListId",
  dispatch_date: "dispatchDate", delivery_address: "deliveryAddress", transport_details: "transportDetails", tracking_reference: "trackingReference",
  delivery_list_item_id: "deliveryListItemId",
  currency_code: "currencyCode", invoice_date: "invoiceDate", due_date: "dueDate", dispatch_line_id: "dispatchLineId", unit_price: "unitPrice",
  discount_amount: "discountAmount", tax_rate: "taxRate", tax_label: "taxLabel", payment_date: "paymentDate",
};

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
    case 202:
      return { status: 202, message: text ?? "The stock booking is not confirmed yet." };
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
