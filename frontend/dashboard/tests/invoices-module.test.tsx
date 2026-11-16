// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
const session = { workspace: null as any };
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useRouter: () => router,
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));
vi.mock("@/lib/tenant-session", () => ({
  requireTenantAdmin: async () => ({ id: "admin-1", role: "organization-admin" }),
  loadWorkspace: async () => session.workspace,
  getTenantToken: () => "token",
}));

import InvoiceTabs from "@/components/invoices/invoice-tabs";
import GoodsReceiptsPage from "@/app/goods-receipts/page";
import InvoicesIndexPage from "@/app/invoices/page";
import NewInvoicePage from "@/app/invoices/(sales)/new/page";
import PurchaseHistory from "@/app/invoices/suppliers/history/purchase-history";

// There is no separate Invoices module: Purchase Invoice (a page of Purchasing) and Sales Invoice (a page of Sales) each have two tabs, New invoice and History. These tests pin the
// routing, the compatibility redirects, the tabs and the rule that nothing is invented for the supplier side (the history is the goods receipts).

beforeEach(() => { session.workspace = { kind: "ready", admin: {}, organization: { modules: ["inventory", "purchasing", "sales"] } }; });
afterEach(cleanup);

const redirectOf = async (run: () => unknown) => {
  try { await run(); } catch (e) { return String((e as Error).message).replace("REDIRECT:", ""); }
  return null;
};

describe("the old addresses keep working", () => {
  it("/goods-receipts forwards to the Purchase Invoice history with only the supplier and the page", async () => {
    expect(await redirectOf(() => GoodsReceiptsPage({ searchParams: {} }))).toBe("/invoices/suppliers/history");
    expect(await redirectOf(() => GoodsReceiptsPage({ searchParams: { q: "dn-7", status: "confirmed", supplier: "s1", from: "2026-11-01", page: "2", organization_id: "other-org", evil: "<x>" } })))
      .toBe("/invoices/suppliers/history?supplier=s1&page=2");
  });

  it("/invoices/new (the old invoice-from-dispatch form) goes to Sales Invoice > New invoice", async () => {
    expect(await redirectOf(() => NewInvoicePage())).toBe("/invoices/sales");
  });

  it("/invoices forwards to Sales Invoice with the old filters (and to Purchase Invoice for a Purchasing-only organization)", async () => {
    expect(await redirectOf(() => InvoicesIndexPage({ searchParams: {} }))).toBe("/invoices/sales");
    expect(await redirectOf(() => InvoicesIndexPage({ searchParams: { client: "c1", status: "issued", payment: "overdue", q: "acme", from: "2026-01-01", to: "2026-02-01", page: "3", organization_id: "x" } })))
      .toBe("/invoices/sales?q=acme&status=issued&payment=overdue&client=c1&from=2026-01-01&to=2026-02-01&page=3");
    session.workspace = { kind: "ready", admin: {}, organization: { modules: ["inventory", "purchasing"] } };
    expect(await redirectOf(() => InvoicesIndexPage({ searchParams: { q: "acme" } }))).toBe("/invoices/suppliers");
  });

  it("with neither module, an unreadable organization or an organization still in setup it goes to the Sales tab, whose own layout explains or redirects", async () => {
    for (const workspace of [
      { kind: "ready", admin: {}, organization: { modules: ["inventory"] } },
      { kind: "ready", admin: {}, organization: null },
      { kind: "unavailable", admin: {} },
      { kind: "setup", admin: {}, organization: { modules: ["inventory", "purchasing", "sales"] } },
    ]) {
      session.workspace = workspace;
      expect(await redirectOf(() => InvoicesIndexPage({ searchParams: {} })), workspace.kind).toBe("/invoices/sales");
    }
  });
});

describe("the two tabs at the top left of Sales Invoice and Purchase Invoice", () => {
  const tabs = () => within(screen.getByRole("navigation")).getAllByRole("link");

  it("Sales Invoice: New invoice, Pending payments and History, in that order, the current one marked", () => {
    render(<InvoiceTabs base="/invoices/sales" current="new" />);
    expect(tabs().map((t) => [t.textContent, t.getAttribute("href"), t.getAttribute("aria-current")])).toEqual([
      ["New invoice", "/invoices/sales", "page"], ["Pending payments", "/invoices/sales/pending", null], ["History", "/invoices/sales/history", null],
    ]);
    cleanup();
    render(<InvoiceTabs base="/invoices/sales" current="pending" />);
    expect(tabs().map((t) => t.getAttribute("aria-current"))).toEqual([null, "page", null]);
    cleanup();
    render(<InvoiceTabs base="/invoices/sales" current="history" />);
    expect(tabs().map((t) => t.getAttribute("aria-current"))).toEqual([null, null, "page"]);
  });

  it("Purchase Invoice has only New invoice and History, on its own addresses (installments are a sales thing)", () => {
    render(<InvoiceTabs base="/invoices/suppliers" current="history" />);
    expect(screen.getByRole("navigation", { name: "Purchase invoice" })).toBeTruthy();
    expect(tabs().map((t) => [t.textContent, t.getAttribute("href"), t.getAttribute("aria-current")])).toEqual([["New invoice", "/invoices/suppliers", null], ["History", "/invoices/suppliers/history", "page"]]);
  });

  it("each tab is a plain link to its own address: one tab's search and filters never reach the other", () => {
    render(<InvoiceTabs base="/invoices/sales" current="new" />);
    for (const tab of tabs()) expect(tab.getAttribute("href")).not.toContain("?");
  });
});

describe("the Purchase Invoice history lists the existing Goods Receipts and invents nothing", () => {
  const receipt = {
    id: "r0000000-0000-4000-8000-000000000001", number: "GR-000001", status: "confirmed", purchase_order: { id: "p1", number: "PO-000001", status: "received" },
    supplier: { id: "s1", name: "Acme Supplies", code: null, is_active: true }, supplier_reference: "DN-7", received_date: "2026-11-07", notes: null, line_count: 2,
    created_by_email: "a@b.c", created_at: "2026-11-07T10:00:00+00:00", confirmed_at: "2026-11-07T11:00:00+00:00", confirmed_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null, updated_at: "2026-11-07T11:00:00+00:00",
  };
  const filters = { q: "", status: "" as const, supplierId: "", dateFrom: "", dateTo: "", page: 1 };

  it("shows each receipt linked to its own page, with its supplier, order, date and status", () => {
    render(<PurchaseHistory list={{ ok: true, items: [receipt], total: 1, limit: 25, offset: 0 } as any} filters={filters} suppliers={[]} />);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Receipt", "Supplier", "Order", "Date", "Status"]);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(within(row).getByRole("link", { name: "GR-000001" }).getAttribute("href")).toBe("/goods-receipts/r0000000-0000-4000-8000-000000000001"); // the detail page keeps its address
    for (const text of ["Acme Supplies", "PO-000001", "2026-11-07", "Confirmed"]) expect(row.textContent, text).toContain(text);
  });

  it("has no invoice number, total, due date, paid amount or payment status column: a goods receipt is not a supplier's bill", () => {
    render(<PurchaseHistory list={{ ok: true, items: [receipt], total: 1, limit: 25, offset: 0 } as any} filters={filters} suppliers={[]} />);
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent!.toLowerCase());
    for (const invented of ["invoice", "total", "due", "paid", "outstanding", "amount", "payment"]) expect(headers.some((h) => h.includes(invented)), invented).toBe(false);
  });
});
