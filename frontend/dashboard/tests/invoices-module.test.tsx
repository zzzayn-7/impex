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

import { NavProvider } from "@/components/dashboard/sidebar";
import InvoicesHeader from "@/components/invoices/invoices-header";
import GoodsReceiptsPage from "@/app/goods-receipts/page";
import InvoicesIndexPage from "@/app/invoices/page";
import ReceiptIndex from "@/app/invoices/suppliers/receipt-index";
import { navGroups } from "@/lib/dashboard-nav";

// Invoices is ONE module with two tabs over two existing systems: Suppliers Invoice (the goods receipts of Purchasing) and Sales Invoice (client invoices of
// Sales). These tests pin the routing, the compatibility redirects, the permission-driven tabs and the rule that nothing is invented for the supplier side.

beforeEach(() => { session.workspace = { kind: "ready", admin: {}, organization: { modules: ["inventory", "purchasing", "sales"] } }; });
afterEach(cleanup);

const redirectOf = async (run: () => unknown) => {
  try { await run(); } catch (e) { return String((e as Error).message).replace("REDIRECT:", ""); }
  return null;
};

describe("the old addresses keep working", () => {
  it("/goods-receipts forwards to Suppliers Invoice with only the list's own search and filters", async () => {
    expect(await redirectOf(() => GoodsReceiptsPage({ searchParams: {} }))).toBe("/invoices/suppliers");
    expect(await redirectOf(() => GoodsReceiptsPage({ searchParams: { q: "dn-7", status: "confirmed", supplier: "s1", from: "2026-11-01", to: "2026-11-30", page: "2", organization_id: "other-org", evil: "<x>" } })))
      .toBe("/invoices/suppliers?q=dn-7&status=confirmed&supplier=s1&from=2026-11-01&to=2026-11-30&page=2");
    expect(await redirectOf(() => GoodsReceiptsPage({ searchParams: { q: ["a", "b"], status: "" } }))).toBe("/invoices/suppliers?q=a");
  });

  it("/invoices forwards to Sales Invoice with the old filters (and to Suppliers Invoice for a Purchasing-only organization)", async () => {
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

describe("the Invoices header and its tabs", () => {
  const shell = (modules: string[], current: "suppliers" | "sales") =>
    render(<NavProvider groups={navGroups(modules)}><InvoicesHeader current={current} /></NavProvider>);

  it("has the title, the one-line explanation and both tabs when the organization has Purchasing and Sales; the current tab is marked", () => {
    shell(["inventory", "purchasing", "sales"], "suppliers");
    expect(screen.getByRole("heading", { level: 2, name: "Invoices" })).toBeTruthy();
    expect(screen.getByText("Manage supplier receipts and customer invoices in one place.")).toBeTruthy();
    const tabs = within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link");
    expect(tabs.map((t) => [t.textContent, t.getAttribute("href")])).toEqual([["Suppliers Invoice", "/invoices/suppliers"], ["Sales Invoice", "/invoices/sales"]]);
    expect(tabs.map((t) => t.getAttribute("aria-current"))).toEqual(["page", null]);
  });

  it("the other tab is current on the Sales Invoice page", () => {
    shell(["inventory", "purchasing", "sales"], "sales");
    expect(within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link").map((t) => t.getAttribute("aria-current"))).toEqual([null, "page"]);
  });

  it("offers only the tab the organization may use: Sales only -> Sales Invoice, Purchasing only -> Suppliers Invoice", () => {
    shell(["inventory", "sales"], "sales");
    expect(within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link").map((t) => t.textContent)).toEqual(["Sales Invoice"]);
    cleanup();
    shell(["inventory", "purchasing"], "suppliers");
    expect(within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link").map((t) => t.textContent)).toEqual(["Suppliers Invoice"]);
  });

  it("each tab is a plain link to its own address: one tab's search and filters never reach the other", () => {
    shell(["inventory", "purchasing", "sales"], "sales");
    for (const tab of within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link")) expect(tab.getAttribute("href")).not.toContain("?");
  });

  it("shown on its own (no shell) it offers both tabs", () => {
    render(<InvoicesHeader current="sales" />);
    expect(within(screen.getByRole("navigation", { name: "Invoices" })).getAllByRole("link")).toHaveLength(2);
  });
});

describe("Suppliers Invoice lists the existing Goods Receipts and invents nothing", () => {
  const receipt = {
    id: "r0000000-0000-4000-8000-000000000001", number: "GR-000001", status: "confirmed", purchase_order: { id: "p1", number: "PO-000001", status: "received" },
    supplier: { id: "s1", name: "Acme Supplies", code: null, is_active: true }, supplier_reference: "DN-7", received_date: "2026-11-07", notes: null, line_count: 2,
    created_by_email: "a@b.c", created_at: "2026-11-07T10:00:00+00:00", confirmed_at: "2026-11-07T11:00:00+00:00", confirmed_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null, updated_at: "2026-11-07T11:00:00+00:00",
  };
  const filters = { q: "", status: "" as const, supplierId: "", dateFrom: "", dateTo: "", page: 1 };

  it("shows each receipt as a Goods Receipt, linked to its own page and its purchase order, with the supplier reference, date, lines and status", () => {
    render(<ReceiptIndex list={{ ok: true, items: [receipt], total: 1, limit: 25, offset: 0 } as any} filters={filters} suppliers={[]} />);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Goods receipt", "Purchase order", "Supplier", "Supplier reference", "Received on", "Lines", "Status"]);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(within(row).getByRole("link", { name: "GR-000001" }).getAttribute("href")).toBe("/goods-receipts/r0000000-0000-4000-8000-000000000001"); // the detail page keeps its address
    expect(within(row).getByRole("link", { name: "PO-000001" }).getAttribute("href")).toBe("/purchase-orders/p1");
    for (const text of ["Acme Supplies", "DN-7", "2026-11-07", "2", "Confirmed"]) expect(row.textContent, text).toContain(text);
  });

  it("has no invoice number, total, due date, paid amount or payment status column: a goods receipt is not a supplier's bill", () => {
    render(<ReceiptIndex list={{ ok: true, items: [receipt], total: 1, limit: 25, offset: 0 } as any} filters={filters} suppliers={[]} />);
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent!.toLowerCase());
    for (const invented of ["invoice", "total", "due", "paid", "outstanding", "amount", "payment"]) expect(headers.some((h) => h.includes(invented)), invented).toBe(false);
    expect(screen.getByText(/Each entry is a/).textContent).toContain("A supplier's own bill is not recorded here");
  });
});
