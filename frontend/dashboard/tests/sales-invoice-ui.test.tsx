// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import InvoiceHistory from "@/app/invoices/(sales)/sales/history/invoice-history";
import NewInvoice from "@/app/invoices/(sales)/sales/new-invoice";
import OrderInvoiceView from "@/app/invoices/(sales)/sales/[id]/order-invoice-view";
import CreateInvoice from "@/app/invoices/(sales)/sales/create/[orderId]/create-invoice";

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

  it("lists each prepared order with its client, date and total, and a Create invoice link to that order", () => {
    render(<NewInvoice list={page([order(ORDER, "SO-000001"), order(ORDER2, "SO-000002", { prices_recorded: false, total_amount: null, currency_code: null })])} filters={filters} clients={clients} refs={[]} />);
    expect(screen.getByText("SO-000001")).toBeTruthy();
    expect(screen.getAllByText(/350\.00/).length).toBeGreaterThan(0); // in the Total column, and under the number on a phone
    expect(screen.getByRole("link", { name: "Create invoice for SO-000001" }).getAttribute("href")).toBe(`/invoices/sales/create/${ORDER}`); // opening it saves nothing
    expect(screen.queryByRole("link", { name: "Create invoice for SO-000002" })).toBeNull(); // no prices, nothing to invoice
    expect(screen.getByText("No prices")).toBeTruthy();
  });

  it("an order that already has an invoice offers View invoice, never a second one", () => {
    render(<NewInvoice list={page([order(ORDER, "SO-000001")])} filters={filters} clients={clients} refs={[{ order_id: ORDER, invoice_id: INVOICE, number: "INV-000007" }]} />);
    expect(screen.queryByRole("link", { name: /Create invoice/ })).toBeNull();
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

  it("shows only the quantity the client receives: '10 pcs', and a number typed into the Unit box (400) is never printed, nor any total", () => {
    const { rerender } = render(<OrderInvoiceView invoice={invoice} />);
    expect(screen.getByText("10 pcs")).toBeTruthy();
    expect(screen.queryByText(/\//)).toBeNull();
    rerender(<OrderInvoiceView invoice={{ ...invoice, lines: [{ ...invoice.lines[0], quantity: "20.0000", unit: "400" }] }} />);
    expect(screen.getByText("20")).toBeTruthy();
    expect(screen.queryByText(/400/)).toBeNull();
    expect(screen.queryByText("20/400")).toBeNull();
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
    expect((await screen.findByRole("alert")).textContent).toContain("could not be prepared");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 401 })));
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

// ---- installments ------------------------------------------------------------------------------------------------------------------
const orderDetail = {
  id: ORDER, number: "SO-000001", client: { id: CLIENT, name: "Alpha Metals", is_active: true }, delivery_list: { id: "l1", number: "DL-000009", status: "ready" }, status: "active", total_amount: "350.0000", currency_code: "USD",
  prices_recorded: true, created_at: now,
  lines: [
    { id: "l-1", product_id: "p1", product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", ordered_quantity: "10.0000", unit_price: "30.0000", line_total: "300.0000" },
    { id: "l-2", product_id: "p2", product_sku: "NUT-1", product_name: "Nut", unit: "pcs", ordered_quantity: "5.0000", unit_price: "10.0000", line_total: "50.0000" },
  ],
} as any;
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// the invoice service: POST makes the invoice, the pdf route gives a file; every call is recorded
function serve(post: () => Response = () => jsonResponse(201, { invoice: { id: INVOICE, number: "INV-000007" }, created: true })) {
  const calls: { url: string; method: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return init.method === "POST" ? post() : new Response(new Blob(["%PDF"]), { status: 200 });
  }));
  return calls;
}
const chooseCount = async (u: ReturnType<typeof user>, n: string) => u.selectOptions(screen.getByLabelText("Number of installments"), n);

describe("Sales Invoice > one order, before the invoice is made", () => {
  beforeEach(() => {
    (URL as any).createObjectURL = vi.fn(() => "blob:invoice");
    (URL as any).revokeObjectURL = vi.fn();
  });

  it("shows the order read-only: Installments at the top right, Print and Download at the bottom right, nothing to type until Installments is opened", () => {
    const { container } = render(<CreateInvoice order={orderDetail} />);
    for (const text of ["SO-000001", "Alpha Metals", "DL-000009", "Steel bolt", "BOLT-1", "10 pcs", "30.00 USD", "350.00 USD"]) expect(container.textContent, text).toContain(text);
    expect(container.querySelector("input, textarea, select")).toBeNull();
    const [installments, print, download, table] = [screen.getByRole("button", { name: "Installments" }), screen.getByRole("button", { name: "Print" }), screen.getByRole("button", { name: "Download" }), container.querySelector("table")!];
    expect(installments.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the products
    expect(table.compareDocumentPosition(print) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // below them
    expect(print.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(print.parentElement!.className).toContain("justify-end");
  });

  it("Installments asks for the number (2 to 5 only) and the time between payments, and nothing can be made until both are chosen", async () => {
    render(<CreateInvoice order={orderDetail} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Installments" }));
    expect(screen.getByRole("button", { name: "Installments" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByLabelText("Number of installments")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose", "2", "3", "4", "5"]);
    expect(within(screen.getByLabelText("Time unit")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Days", "Weeks", "Months"]);
    expect((screen.getByLabelText("Time between payments") as HTMLInputElement).value).toBe("1");
    for (const name of ["Create invoice", "Print", "Download"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    await chooseCount(u, "3");
    for (const name of ["Create invoice", "Print", "Download"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(false);
    await u.click(screen.getByRole("button", { name: "Installments" })); // closing it goes back to a whole-order invoice
    expect(screen.queryByLabelText("Number of installments")).toBeNull();
    expect((screen.getByRole("button", { name: "Print" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("previews the payments: equal parts, the last one takes the leftover cents, and the first one is shown at the bottom", async () => {
    render(<CreateInvoice order={orderDetail} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Installments" }));
    await chooseCount(u, "5");
    expect(document.querySelector("[data-installment-summary]")!.textContent).toBe("5 payments of 70.00 USD");
    await chooseCount(u, "3");
    expect(document.querySelector("[data-installment-summary]")!.textContent).toBe("3 payments of 116.66 USD (the last one 116.68 USD)");
    expect(screen.getByText("Installment 1 of 3")).toBeTruthy();
    const every = screen.getByLabelText("Time between payments");
    await u.clear(every);
    await u.type(every, "13"); // 13 months is more than the 12 allowed: refused
    expect((screen.getByRole("button", { name: "Create invoice" }) as HTMLButtonElement).disabled).toBe(true);
    await u.clear(every);
    await u.type(every, "0");
    expect((screen.getByRole("button", { name: "Create invoice" }) as HTMLButtonElement).disabled).toBe(true);
    await u.clear(every);
    await u.type(every, "45");
    await u.selectOptions(screen.getByLabelText("Time unit"), "days");
    expect((screen.getByRole("button", { name: "Create invoice" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Create invoice sends the order and the plan, then opens the first invoice", async () => {
    const calls = serve();
    render(<CreateInvoice order={orderDetail} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Installments" }));
    await chooseCount(u, "3");
    await u.selectOptions(screen.getByLabelText("Time unit"), "weeks");
    await u.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/sales/${INVOICE}`));
    expect(calls).toEqual([{ url: "/api/sales/order-invoices", method: "POST", body: { orderId: ORDER, installments: { count: 3, every: 1, unit: "weeks" } } }]);
  });

  it("Print makes the invoice for the whole order (no installments), prints it, and does not make a second one", async () => {
    const calls = serve();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<CreateInvoice order={orderDetail} />);
    await user().click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(document.querySelector("iframe[title='Invoice to print']")).not.toBeNull());
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([["POST", "/api/sales/order-invoices", { orderId: ORDER }], ["GET", `/api/sales/order-invoices/${INVOICE}/pdf?inline=1`, undefined]]);
    expect(screen.getByRole("status").textContent).toContain("INV-000007");
    expect((screen.getByRole("button", { name: "Installments" }) as HTMLButtonElement).disabled).toBe(true); // it is made: the installments can no longer be chosen
    document.querySelector("iframe")!.remove();
    await user().click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls[2]).toEqual({ url: `/api/sales/order-invoices/${INVOICE}/pdf`, method: "GET", body: undefined }); // the same invoice, not a new POST
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    click.mockRestore();
  });

  it("Download with the installments filled in makes the installment invoices first", async () => {
    const calls = serve();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<CreateInvoice order={orderDetail} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Installments" }));
    await chooseCount(u, "2");
    await u.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ orderId: ORDER, installments: { count: 2, every: 1, unit: "months" } });
    click.mockRestore();
  });

  it("says why the invoice cannot be made, keeps everything as it was, and goes to the login page when the session ended", async () => {
    serve(() => jsonResponse(409, { error: "SO-000001 is not a prepared order waiting to be dispatched, so it cannot be invoiced here." }));
    render(<CreateInvoice order={orderDetail} />);
    await user().click(screen.getByRole("button", { name: "Print" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not a prepared order");
    expect(document.querySelector("iframe")).toBeNull();
    expect((screen.getByRole("button", { name: "Print" }) as HTMLButtonElement).disabled).toBe(false);
    serve(() => jsonResponse(401, { error: "x" }));
    await user().click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("a double click on Print makes one request", async () => {
    const calls = serve();
    render(<CreateInvoice order={orderDetail} />);
    const print = screen.getByRole("button", { name: "Print" });
    fireEvent.click(print);
    fireEvent.click(print);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
  });
});

describe("Sales Invoice > History and Pending payments rows", () => {
  const h = { clientId: "", day: "", page: 1 };
  const orderRow = { kind: "order", id: INVOICE, number: "INV-000007", client_id: CLIENT, client_name: "Alpha Metals", invoice_date: "2026-11-07", currency_code: "USD", total: "350.0000", status: "issued", order_number: "SO-000001" } as any;
  const oldRow = { kind: "invoice", id: "a0000000-0000-4000-8000-0000000000aa", number: "INV-000001", client_id: CLIENT, client_name: "Alpha Metals", invoice_date: "2026-11-01", currency_code: "USD", total: "25.0000", status: "issued", order_number: null } as any;

  beforeEach(() => {
    (URL as any).createObjectURL = vi.fn(() => "blob:invoice");
    (URL as any).revokeObjectURL = vi.fn();
  });

  it("every row has Print and Download: an order invoice and an older invoice each use their own PDF address", async () => {
    const calls = serve();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<InvoiceHistory list={page([orderRow, oldRow])} filters={h} clients={clients} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Print INV-000007" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    document.querySelector("iframe")!.remove();
    await u.click(screen.getByRole("button", { name: "Download INV-000001" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.map((c) => c.url)).toEqual([`/api/sales/order-invoices/${INVOICE}/pdf?inline=1`, `/api/sales/invoices/${oldRow.id}/pdf`]);
    click.mockRestore();
  });

  it("says so when a file cannot be prepared, and goes to the login page when the session ended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 502 })));
    render(<InvoiceHistory list={page([orderRow])} filters={h} clients={clients} />);
    await user().click(screen.getByRole("button", { name: "Download INV-000007" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be prepared");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 401 })));
    await user().click(screen.getByRole("button", { name: "Download INV-000007" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("an installment says which one it is", () => {
    render(<InvoiceHistory list={page([{ ...orderRow, installment_no: 1, installment_count: 3 }])} filters={h} clients={clients} />);
    expect(screen.getByText("Installment 1 of 3")).toBeTruthy();
  });

  it("Pending payments is the same list on its own address, with its own tab current and its own empty states", async () => {
    const { unmount } = render(<InvoiceHistory view="pending" list={page([{ ...orderRow, status: "pending", installment_no: 2, installment_count: 3 }])} filters={h} clients={clients} />);
    expect(screen.getByRole("link", { name: "Pending payments" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Installment 2 of 3")).toBeTruthy();
    await user().selectOptions(screen.getByLabelText("Client"), CLIENT);
    expect(router.push).toHaveBeenLastCalledWith(`/invoices/sales/pending?client=${CLIENT}`);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-12-07" } });
    expect(router.push).toHaveBeenLastCalledWith("/invoices/sales/pending?date=2026-12-07");
    unmount();
    const second = render(<InvoiceHistory view="pending" list={page([])} filters={h} clients={clients} />);
    expect(screen.getByText("No pending payments.")).toBeTruthy();
    second.unmount();
    render(<InvoiceHistory view="pending" list={page([])} filters={{ ...h, day: "2026-12-07" }} clients={clients} />);
    expect(screen.getByText("No pending payments found.")).toBeTruthy();
  });
});

describe("one order invoice paid in installments", () => {
  const base = {
    id: INVOICE, number: "INV-000008", invoice_date: "2026-12-07", currency_code: "USD", notes: null, client_id: CLIENT, client_name: "Alpha Metals", client_address: null, seller_name: null,
    order_id: ORDER, order_number: "SO-000001", delivery_list_number: null, subtotal: "350.0000", total: "116.6600", installment_no: 2, installment_count: 3, created_by_email: "a@b.c", created_at: now,
    schedule: [
      { id: "i1", number: "INV-000007", installment_no: 1, invoice_date: "2026-11-07", total: "116.6600" },
      { id: INVOICE, number: "INV-000008", installment_no: 2, invoice_date: "2026-12-07", total: "116.6600" },
      { id: "i3", number: "INV-000009", installment_no: 3, invoice_date: "2027-01-07", total: "116.6800" },
    ],
    lines: [{ product_id: "p1", product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", quantity: "10.0000", unit_price: "30.0000", line_total: "300.0000" }],
  } as any;

  it("says which installment it is, shows the order total and what THIS invoice asks for, and lists every payment with a link to the others", () => {
    const { container } = render(<OrderInvoiceView invoice={base} />);
    expect(screen.getAllByText("Installment 2 of 3").length).toBeGreaterThan(0);
    for (const text of ["Order total", "350.00 USD", "116.66 USD", "116.68 USD", "2026-11-07", "2027-01-07"]) expect(container.textContent, text).toContain(text);
    expect(screen.getByRole("link", { name: "INV-000007" }).getAttribute("href")).toBe("/invoices/sales/i1");
    expect(screen.getByRole("link", { name: "INV-000009" }).getAttribute("href")).toBe("/invoices/sales/i3");
    expect(screen.queryByRole("link", { name: "INV-000008" })).toBeNull(); // this one is the page itself
  });

  it("Print and Download are below the products, at the right", () => {
    const { container } = render(<OrderInvoiceView invoice={base} />);
    const print = screen.getByRole("button", { name: "Print" });
    expect(container.querySelector("table")!.compareDocumentPosition(print) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(print.parentElement!.className).toContain("justify-end");
  });

  it("an invoice without installments shows no installment line and no payments list", () => {
    const { container } = render(<OrderInvoiceView invoice={{ ...base, installment_no: 1, installment_count: 1, schedule: [], total: "350.0000" }} />);
    expect(container.textContent).not.toContain("Installment");
    expect(container.textContent).not.toContain("Order total");
    expect(container.querySelector('section[aria-label="Payments"]')).toBeNull();
  });
});
