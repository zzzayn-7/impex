import { NextResponse } from "next/server";

// Server-side only. Talks to the Purchasing Service with the signed-in administrator's own session token (the HttpOnly
// tenant cookie). Nothing here ever names an organization: the Purchasing Service derives it from the token, so there is
// nothing for the browser to tamper with. (See docs/multi-tenancy.md.)

export function purchasingServiceUrl(): string {
  return (process.env.PURCHASING_SERVICE_URL || "http://localhost:8004").replace(/\/$/, "");
}

export type PurchasingResult = { status: number; data: any } | null; // null = the service could not be reached

export async function purchasingRequest(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<PurchasingResult> {
  try {
    const res = await fetch(`${purchasingServiceUrl()}${path}`, {
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

// ---- types (what the Purchasing Service returns; no organization_id is ever included) -----------------------------------
export type Supplier = {
  id: string;
  name: string;
  code: string | null;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  country_code: string | null;
  tax_identifier: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type OrderStatus = "draft" | "ordered" | "partially_received" | "received" | "cancelled";

export type PurchaseOrderSummary = {
  id: string;
  number: string;
  supplier: { id: string; name: string; code: string | null; is_active: boolean };
  supplier_reference: string | null;
  order_date: string;
  expected_delivery_date: string | null;
  currency_code: string;
  notes: string | null;
  status: OrderStatus;
  line_count: number;
  total_amount: string;
  created_by_email: string;
  ordered_at: string | null;
  ordered_by_email: string | null;
  cancelled_at: string | null;
  cancelled_by_email: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderLine = {
  id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  quantity: string;
  unit_price: string;
  line_total: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // How much has arrived: only CONFIRMED goods receipts count as received; a receipt being posted is pending (reserved).
  received_quantity?: string;
  pending_quantity?: string;
  remaining_quantity?: string;
};

export type ReceiptStatus = "draft" | "posting" | "confirmed" | "cancelled";

export type ReceiptSummary = {
  id: string;
  number: string;
  status: ReceiptStatus;
  purchase_order: { id: string; number: string; status: OrderStatus };
  supplier: { id: string; name: string; code: string | null; is_active: boolean };
  supplier_reference: string | null;
  received_date: string;
  notes: string | null;
  line_count: number;
  created_by_email: string;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by_email: string | null;
  cancelled_at: string | null;
  cancelled_by_email: string | null;
  updated_at: string;
};

export type ReceiptLine = {
  id: string;
  purchase_order_line_id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  unit: string;
  ordered_quantity: string;
  received_elsewhere_quantity: string;
  pending_elsewhere_quantity: string;
  receivable_quantity: string;
  accepted_quantity: string;
  rejected_quantity: string;
  notes: string | null;
  inventory_movement_id: string | null;
};

export type ReceiptDetail = ReceiptSummary & {
  lines: ReceiptLine[];
  posting: { attempts: number; started_at: string | null; last_attempt_at: string | null; last_error: string | null };
  inventory_operation_id: string | null;
  editable: boolean;
  stock_notice: string;
};

export type PurchaseOrderDetail = PurchaseOrderSummary & {
  lines: OrderLine[];
  frozen: boolean;
  stock_notice: string;
  receipts?: ReceiptSummary[];
  can_receive?: boolean;
};

// ---- reading (used by the server-rendered pages) --------------------------------------------------------------------------
export const PAGE_SIZE = 25;
type Failure = { ok: false; reason: "unauthorized" | "forbidden" | "not-found" | "unavailable" };
export type Paged<T> = { ok: true; items: T[]; total: number; limit: number; offset: number } | Failure;

function failure(result: PurchasingResult): Failure {
  const status = result?.status;
  return { ok: false, reason: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable" };
}

async function getPaged<T>(path: string, params: URLSearchParams, token: string): Promise<Paged<T>> {
  const result = await purchasingRequest("GET", `${path}?${params}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, items: result.data.items, total: result.data.total, limit: result.data.limit, offset: result.data.offset };
}

export type SupplierFilters = { q: string; status: "active" | "inactive" | "all"; page: number };
export function listSuppliers(token: string, filters: SupplierFilters) {
  const params = new URLSearchParams({ status: filters.status, limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  return getPaged<Supplier>("/api/v1/purchasing/suppliers", params, token);
}

export async function listSupplierChoices(token: string, status: "active" | "all" = "active"): Promise<Supplier[]> {
  const result = await getPaged<Supplier>("/api/v1/purchasing/suppliers", new URLSearchParams({ status, limit: "200" }), token);
  return result.ok ? result.items : [];
}

export type OrderFilters = { q: string; supplierId: string; status: OrderStatus | ""; page: number };
export function listPurchaseOrders(token: string, filters: OrderFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.supplierId) params.set("supplier_id", filters.supplierId);
  if (filters.status) params.set("status", filters.status);
  return getPaged<PurchaseOrderSummary>("/api/v1/purchasing/purchase-orders", params, token);
}

export async function getPurchaseOrder(token: string, id: string): Promise<{ ok: true; order: PurchaseOrderDetail } | Failure> {
  const result = await purchasingRequest("GET", `/api/v1/purchasing/purchase-orders/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, order: result.data };
}

export type ReceiptFilters = { q: string; status: ReceiptStatus | ""; supplierId: string; dateFrom: string; dateTo: string; page: number };
export function listGoodsReceipts(token: string, filters: ReceiptFilters) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((filters.page - 1) * PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.supplierId) params.set("supplier_id", filters.supplierId);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return getPaged<ReceiptSummary>("/api/v1/purchasing/goods-receipts", params, token);
}

export async function getGoodsReceipt(token: string, id: string): Promise<{ ok: true; receipt: ReceiptDetail } | Failure> {
  const result = await purchasingRequest("GET", `/api/v1/purchasing/goods-receipts/${id}`, token);
  if (!result || result.status !== 200) return failure(result);
  return { ok: true, receipt: result.data };
}

// ---- failures from write calls, turned into safe responses for the browser ------------------------------------------------
export type PurchasingFailure = {
  status: number;
  message: string;
  code?: string; // e.g. "duplicate_line"
  line?: { id: string; quantity: string; unit: string; unit_price: string; product_name: string }; // the existing line, for duplicate_line
  fieldErrors?: Record<string, string>;
};

const FIELD_NAMES: Record<string, string> = {
  supplier_id: "supplierId", supplier_reference: "supplierReference", currency_code: "currencyCode", order_date: "orderDate",
  expected_delivery_date: "expectedDeliveryDate", unit_price: "unitPrice", product_id: "productId", contact_person: "contactPerson",
  received_date: "receivedDate", accepted_quantity: "acceptedQuantity", rejected_quantity: "rejectedQuantity",
  purchase_order_line_id: "purchaseOrderLineId", purchase_order_id: "purchaseOrderId",
  country_code: "countryCode", tax_identifier: "taxIdentifier",
};

export function describePurchasingFailure(result: PurchasingResult, notFound = "Not found."): PurchasingFailure {
  if (!result) return { status: 503, message: "The purchasing service is unavailable. Please try again shortly." };
  const detail = result.data?.detail;
  const text = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : null;
  switch (result.status) {
    case 400:
      return { status: 400, message: text ?? "The request was not accepted." };
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
        ...(detail && typeof detail === "object" && !Array.isArray(detail) ? { code: detail.code, line: detail.line } : {}),
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

export function purchasingFailureResponse(result: PurchasingResult, notFound?: string) {
  const { status, message, ...rest } = describePurchasingFailure(result, notFound);
  return NextResponse.json({ error: message, ...rest }, { status, headers: { "Cache-Control": "no-store" } });
}
