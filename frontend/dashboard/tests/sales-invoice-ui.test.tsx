// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import InvoiceHistory from "@/app/invoices/(sales)/sales/history/invoice-history";
import NewInvoice from "@/app/invoices/(sales)/sales/new-invoice";
import OrderInvoiceView from "@/app/invoices/(sales)/sales/[id]/order-invoice-view";

// Sales Invoice: "New invoice" (a client, then that client's prepared orders, one Create invoice button each), "History" (client + date filters) and the invoice of one order
// (read-only, Print and Download).

const CLIENT = "c1111111-1111-4111-8111-111111111111";
const ORDER = "d0000000-0000-4000-8000-000000000001";
const ORDER2 = "d0000000-0000-4000-8000-000000000002";
const INVOICE = "9f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const now = "2026-11-07T10:00:00+00:00";
const clients = [{ id: CLIENT, name: "Alpha Metals", is_active: true } as any, { id: "c2", name: "Old Client", is_active: false } as any];
const order = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: CLIENT, name: "Alpha Metals" }, status: "active", created_at: now, total_amount: "350.0000", currency_code: "USD", prices_recorded: true, ...extra,
}) as any;
const page = (items: any[]) => ({ ok: true as const, items, total: items.length, limit: 25, offset: 0 });
const filters = { clientId: "", q: "", page: 1 };
const user = () => userEvent.setup();

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Sales Invoice > New invoice", () => {
  it("has the New invoice and History tabs, New invoice current", () => {
    render(<NewInvoice list={page([])} filters={filters} clients={clients} refs={[]} />);
    expect(screen.getByRole("link", { name: "New invoice" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/invoices/sales/history");
  });

  it("lists each prepared order with its client, date and total, and a Create invoice button", () => {
    render(<NewInvoice list={page([order(ORDER, "SO-000001"), order(ORDER2, "SO-000002", { prices_recorded: false, total_amount: null, currency_code: null })])} filters={filters} clients={clients} refs={[]} />);
    expect(screen.getByText("SO-000001")).toBeTruthy();
    expect(screen.getAllByText(/350\.00/).length).toBeGreaterThan(0); // in the Total column, and under the number on a phone
    expect(screen.getByRole("button", { name: "Create invoice for SO-000001" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create invoice for SO-000002" })).toBeNull(); // no prices, nothing to invoice
    expect(screen.getByText("No prices")).toBeTruthy();
  });

  it("an order that already has an invoice offers View invoice, never a second one", () => {
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[{ order_id: ORDER, invoice_id: INVOICE, number: "INV-000007" }]} />);
    expect(screen.queryByRole("button", { name: /Create invoice/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View invoice INV-000007" }).getAttribute("href")).toBe(`/invoices/sales/${INVOICE}`);
  });

  it("choosing a client or searching narrows the list through whitelisted query parameters", async () => {
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[]} />);
    const u = user();
    await u.selectOptions(screen.getByLabelText("Client"), CLIENT);
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales?client=${CLIENT}`);
    await u.type(screen.getByLabelText("Search"), "so-1{enter}");
    expect(router.push).toHaveBeenLastCalledWith("/invoices/sales?q=so-1");
    await u.selectOptions(screen.getByLabelText("Client"), "");
    expect(router.push).toHaveBeenLastCalledWith("/invoices/sales");
  });

  it("Create invoice sends only the order id, then opens the invoice; a double click makes one request", async () => {
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[]} />);
    const button = screen.getByRole("button", { name: "Create invoice for SO-000001" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sales/order-invoices");
    expect(JSON.parse(String(init.body))).toEqual({ orderId: ORDER });
    expect(screen.getByRole("button", { name: "Create invoice for SO-000001" }).textContent).toBe("Creating…");
    finish(new Response(JSON.stringify({ invoice: { id: INVOICE, number: "INV-000007" }, created: true }), { status: 201, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/sales/${INVOICE}`));
  });

  it("says why when the invoice cannot be made, and lets the person try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "SO-000001 is not a prepared order waiting to be dispatched, so it cannot be invoiced here." }), { status: 409, headers: { "Content-Type": "application/json" } })));
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create invoice for SO-000001" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not a prepared order");
    expect(router.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create invoice for SO-000001" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an expired session goes to the login page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 401, headers: { "Content-Type": "application/json" } })));
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create invoice for SO-000001" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("shows the empty states and an outage", () => {
    const { unmount } = render(<NewInvoice list={page([])} filters={filters} clients={clients} refs={[]} />);
    expect(screen.getByText("No orders waiting to be dispatched.")).toBeTruthy();
    unmount();
    const second = render(<NewInvoice list={page([])} filters={{ ...filters, q: "zzz" }} clients={clients} refs={[]} />);
    expect(screen.getByText("No orders found.")).toBeTruthy();
    second.unmount();
    render(<NewInvoice list={{ ok: false, reason: "unavailable" } as any} filters={filters} clients={clients} refs={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});

describe("Sales Invoice > History", () => {
  const rows = [
    { kind: "order", id: INVOICE, number: "INV-000007", client_id: CLIENT, client_name: "Alpha Metals", invoice_date: "2026-11-07", currency_code: "USD", total: "350.0000", status: "issued", order_number: "SO-000001" },
    { kind: "invoice", id: "a0000000-0000-4000-8000-0000000000aa", number: "INV-000001", client_id: CLIENT, client_name: "Alpha Metals", invoice_date: "2026-11-01", currency_code: "USD", total: "25.0000", status: "partially_paid", order_number: null },
  ] as any[];
  const h = { clientId: "", day: "", page: 1 };

  it("has the New invoice and History tabs, History current", () => {
    render(<InvoiceHistory list={page(rows)} filters={h} clients={clients} />);
    expect(screen.getByRole("link", { name: "History" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "New invoice" }).getAttribute("href")).toBe("/invoices/sales");
  });

  it("lists the invoices, each opening its own page; an older invoice shows its payment state", () => {
    render(<InvoiceHistory list={page(rows)} filters={h} clients={clients} />);
    expect(screen.getByRole("link", { name: "INV-000007" }).getAttribute("href")).toBe(`/invoices/sales/${INVOICE}`);
    expect(screen.getByRole("link", { name: "INV-000001" }).getAttribute("href")).toBe("/invoices/a0000000-0000-4000-8000-0000000000aa");
    expect(screen.getByText("Part paid")).toBeTruthy();
    expect(screen.getAllByText("Alpha Metals").length).toBeGreaterThan(0);
  });

  it("the client and the date narrow the list, alone or together", async () => {
    const { rerender } = render(<InvoiceHistory list={page(rows)} filters={h} clients={clients} />);
    const u = user();
    await u.selectOptions(screen.getByLabelText("Client"), CLIENT);
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales/history?client=${CLIENT}`);
    rerender(<InvoiceHistory list={page(rows)} filters={{ ...h, clientId: CLIENT }} clients={clients} />);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-07" } });
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales/history?client=${CLIENT}&date=2026-11-07`);
    rerender(<InvoiceHistory list={page(rows)} filters={{ ...h, day: "2026-11-07" }} clients={clients} />);
    await u.selectOptions(screen.getByLabelText("Client"), "");
    expect(router.push).toHaveBeenLastCalledWith("/invoices/sales/history?date=2026-11-07");
  });

  it("Clear removes both filters, and the empty states differ", async () => {
    const { unmount } = render(<InvoiceHistory list={page([])} filters={{ ...h, clientId: CLIENT, day: "2026-11-07" }} clients={clients} />);
    expect(screen.getByText("No invoices found.")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Clear" }));
    expect(router.push).toHaveBeenLastCalledWith("/invoices/sales/history");
    unmount();
    render(<InvoiceHistory list={page([])} filters={h} clients={clients} />);
    expect(screen.getByText("No invoices yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("pages forward and back keeping the filters", async () => {
    const list = { ok: true as const, items: rows, total: 60, limit: 25, offset: 25 };
    render(<InvoiceHistory list={list} filters={{ ...h, clientId: CLIENT, page: 2 }} clients={clients} />);
    expect(screen.getByText("Showing 26–27 of 60")).toBeTruthy();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales/history?client=${CLIENT}&page=3`);
    await u.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales/history?client=${CLIENT}`);
  });
});

describe("one order invoice", () => {
  const invoice = {
    id: INVOICE, number: "INV-000007", invoice_date: "2026-11-07", currency_code: "USD", notes: null, client_id: CLIENT, client_name: "Alpha Metals", client_address: "1 Main St", seller_name: "Alpha Trading",
    order_id: ORDER, order_number: "SO-000001", delivery_list_number: "DL-000009", subtotal: "350.0000", total: "350.0000", created_by_email: "a@b.c", created_at: now,
    lines: [
      { product_id: "p1", product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", quantity: "10.0000", unit_price: "30.0000", line_total: "300.0000" },
      { product_id: "p2", product_sku: "NUT-1", product_name: "Nut", unit: "pcs", quantity: "5.0000", unit_price: "10.0000", line_total: "50.0000" },
    ],
  } as any;

  it("shows the order's details, its products and the total, with nothing to edit", () => {
    const { container } = render(<OrderInvoiceView invoice={invoice} />);
    for (const text of ["INV-000007", "Alpha Metals", "1 Main St", "SO-000001", "DL-000009", "2026-11-07", "Steel bolt", "BOLT-1", "Nut"]) expect(container.textContent, text).toContain(text);
    expect(within(container).getAllByText(/350\.00/).length).toBeGreaterThan(0);
    expect(container.querySelector("input, textarea, select")).toBeNull();
  });

  it("a word unit reads '10 pcs'; a numeric unit reads <pieces/total>, e.g. 20/400", () => {
    const { rerender } = render(<OrderInvoiceView invoice={invoice} />);
    expect(screen.getByText("10 pcs")).toBeTruthy();
    expect(screen.queryByText(/\//)).toBeNull();
    rerender(<OrderInvoiceView invoice={{ ...invoice, lines: [{ ...invoice.lines[0], quantity: "20.0000", unit: "400" }] }} />);
    expect(screen.getByText("20/400")).toBeTruthy();
  });

  it("Download is a link to the PDF", () => {
    render(<OrderInvoiceView invoice={invoice} />);
    const link = screen.getByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe(`/api/sales/order-invoices/${INVOICE}/pdf`);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("Print fetches the same PDF, inline, and prints it from a hidden frame", async () => {
    (URL as any).createObjectURL = vi.fn(() => "blob:invoice");
    (URL as any).revokeObjectURL = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new Blob(["%PDF"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OrderInvoiceView invoice={invoice} />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(document.querySelector("iframe[title='Invoice to print']")).not.toBeNull());
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`/api/sales/order-invoices/${INVOICE}/pdf?inline=1`);
    expect(document.querySelector("iframe")!.getAttribute("aria-hidden")).toBe("true");
    document.querySelector("iframe")!.remove();
  });

  it("says so when the invoice cannot be prepared for printing, and goes to login when the session ended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 502 })));
    render(<OrderInvoiceView invoice={invoice} />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be prepared for printing");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 401 })));
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});
