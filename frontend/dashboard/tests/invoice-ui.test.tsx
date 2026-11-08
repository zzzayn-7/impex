// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import ClientAccountView from "@/app/clients/[id]/client-account";
import InvoiceDetailView from "@/app/invoices/[id]/invoice-detail";
import InvoiceForm from "@/app/invoices/invoice-form";
import InvoiceIndex from "@/app/invoices/invoice-index";
import PortalShell from "@/components/dashboard/frame";
import DispatchDetailView from "@/app/dispatches/[id]/dispatch-detail";

const now = "2026-11-07T10:00:00+00:00";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-000000000002";
const LIST = "a0000000-0000-4000-8000-000000000001";
const DISPATCH = "d0000000-0000-4000-8000-000000000001";
const DISPATCH2 = "d0000000-0000-4000-8000-000000000002";
const BOLT_LINE = "e0000000-0000-4000-8000-000000000001";
const FLOUR_LINE = "e0000000-0000-4000-8000-000000000002";
const OLD_LINE = "e0000000-0000-4000-8000-000000000003";
const INVOICE = "f0000000-0000-4000-8000-000000000001";
const PAYMENT = "99999999-0000-4000-8000-000000000001";

const acme = { id: CLIENT, name: "Acme Ltd", is_active: true };
const clients = [
  { ...acme, contact_person: null, email: null, phone: null, address: null, created_at: now, updated_at: now },
  { id: OTHER, name: "Zenith Ltd", is_active: true, contact_person: null, email: null, phone: null, address: null, created_at: now, updated_at: now },
  { id: "c0000000-0000-4000-8000-000000000003", name: "Dormant Ltd", is_active: false, contact_person: null, email: null, phone: null, address: null, created_at: now, updated_at: now },
];

const billable = (extra: Record<string, unknown> = {}) => ({
  dispatch_line_id: BOLT_LINE, dispatch_id: DISPATCH, dispatch_number: "DS-000001", dispatch_date: "2026-11-05", delivery_list: { id: LIST, number: "DL-000001", status: "partially_dispatched" },
  product_id: "b0000000-0000-4000-8000-000000000001", product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", warehouse_code: "MAIN", dispatched_quantity: "10.0000",
  invoiced_quantity: "0.0000", in_drafts_quantity: "0.0000", remaining_quantity: "10.0000", ...extra,
});
const BILLABLE = [
  billable(),
  billable({ dispatch_line_id: FLOUR_LINE, product_id: "b0000000-0000-4000-8000-000000000002", product_sku: "FLOUR", product_name: "Flour", unit: "kg", dispatched_quantity: "2.0000", remaining_quantity: "2.0000" }),
  billable({ dispatch_line_id: OLD_LINE, dispatch_id: DISPATCH2, dispatch_number: "DS-000002", dispatched_quantity: "5.0000", invoiced_quantity: "5.0000", remaining_quantity: "0.0000" }),
];

const summary = (extra: Record<string, unknown> = {}) => ({
  id: INVOICE, number: "INV-000001", status: "issued", client: acme, delivery_list: { id: LIST, number: "DL-000001", status: "partially_dispatched" }, invoice_date: "2026-11-01", due_date: "2999-01-01",
  currency_code: "USD", subtotal: "25.0000", discount_total: "0.0000", tax_total: "0.0000", total: "25.0000", paid_total: "0.0000", outstanding: "25.0000", overdue: false, line_count: 1,
  created_by_email: "a@b.c", issued_at: now, issued_by_email: "a@b.c", voided_at: null, updated_at: now, ...extra,
});
const payment = (extra: Record<string, unknown> = {}) => ({
  id: PAYMENT, invoice_id: INVOICE, kind: "payment", reverses_payment_id: null, payment_date: "2026-11-05", amount: "10.0000", currency_code: "USD", method: "cash", reference: "RCPT-1", notes: null,
  recorded_by_email: "a@b.c", created_at: now, reversed: false, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(), seller_name: "Alpha Trading", client_name: "Acme Ltd", client_address: "1 Main St", notes: null, void_reason: null,
  lines: [{
    id: "11111111-0000-4000-8000-000000000001", product_id: "b0000000-0000-4000-8000-000000000001", product_sku: "BOLT-1", product_name: "Steel bolt", unit: "pcs", quantity: "10.0000", unit_price: "2.5000",
    discount_amount: "1.0000", tax_rate: "10.0000", tax_label: "VAT", line_subtotal: "25.0000", line_net: "24.0000", line_tax: "2.4000", line_total: "26.4000",
    allocations: [{ dispatch_line_id: BOLT_LINE, dispatch_id: DISPATCH, dispatch_number: "DS-000001", quantity: "10.0000" }],
  }],
  payments: [], editable: false, can_issue: false, can_void: true, can_record_payment: true, disclaimer: "This document records goods supplied. It does not certify that this invoice meets any tax or legal requirement.",
  ...extra,
});
const issued = (extra: Record<string, unknown> = {}) => detail({ subtotal: "25.0000", discount_total: "1.0000", tax_total: "2.4000", total: "26.4000", outstanding: "26.4000", ...extra });
const draft = (extra: Record<string, unknown> = {}) => issued({ number: null, status: "draft", editable: true, can_issue: true, can_record_payment: false, issued_at: null, issued_by_email: null, ...extra });
const partial = (extra: Record<string, unknown> = {}) => issued({ status: "partially_paid", paid_total: "10.0000", outstanding: "16.4000", payments: [payment()], can_void: false, ...extra });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[];
let server: Record<string, (body: any, url: string, headers: any) => Response | Promise<Response>>;

function stub() {
  calls = [];
  server = {};
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    const key = `${method} ${url.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`;
    if (server[key]) return server[key](body, url, init.headers ?? {});
    return json(404, { error: "not found" });
  }));
}
const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const stockCalls = () => calls.filter((c) => /\/api\/(stock|products|inventory|warehouses|movements)/.test(c.url));

beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset(); stub(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const user = () => userEvent.setup();

// =====================================================================================================
// Index
// =====================================================================================================
describe("Invoices index", () => {
  const filters = { q: "", status: "" as const, paymentStatus: "" as const, clientId: "", dateFrom: "", dateTo: "", page: 1 };
  const page = (items: any[], extra: Record<string, unknown> = {}) => ({ ok: true as const, items, total: items.length, limit: 25, offset: 0, ...extra });
  const mount = (list: any, f: Record<string, unknown> = {}) => render(<InvoiceIndex list={list} filters={{ ...filters, ...f } as any} clients={clients as any} />);

  it("shows each invoice with amounts, a draft without a number and an overdue date", () => {
    mount(page([summary(), summary({ id: "x2", number: null, status: "draft", delivery_list: null }), summary({ id: "x3", number: "INV-000003", overdue: true, due_date: "2025-01-31", paid_total: "5.0000", outstanding: "20.0000", status: "partially_paid" })]));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("INV-000001");
    expect(rows[0].textContent).toContain("25.00 USD");
    expect(rows[1].textContent).toContain("Draft");
    expect(rows[2].textContent).toContain("overdue");
    expect(rows[2].textContent).toContain("Partially paid");
    expect(screen.getByRole("link", { name: "INV-000001" }).getAttribute("href")).toBe(`/invoices/${INVOICE}`);
    expect(screen.getByRole("link", { name: "New Invoice" }).getAttribute("href")).toBe("/invoices/new");
  });

  it("each filter changes the address and returns to page 1", async () => {
    mount(page([summary()], { total: 80 }), { page: 3 });
    const u = user();
    await u.selectOptions(screen.getByLabelText("Status"), "issued");
    expect(router.push).toHaveBeenLastCalledWith("/invoices?status=issued");
    await u.selectOptions(screen.getByLabelText("Payment"), "overdue");
    expect(router.push).toHaveBeenLastCalledWith("/invoices?payment=overdue&page=3".replace("&page=3", ""));
    await u.selectOptions(screen.getByLabelText("Client"), CLIENT);
    expect(router.push).toHaveBeenLastCalledWith(`/invoices?client=${CLIENT}`);
    await u.type(screen.getByRole("searchbox"), "acme");
    await u.click(screen.getByRole("button", { name: "Search" }));
    expect(router.push).toHaveBeenLastCalledWith("/invoices?q=acme");
  });

  it("lists every status, payment status and client (inactive ones marked)", () => {
    mount(page([summary()]));
    expect(within(screen.getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All statuses", "Draft", "Issued", "Partially paid", "Paid", "Void"]);
    expect(within(screen.getByLabelText("Payment")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Any payment status", "Unpaid", "Partially paid", "Paid", "Overdue"]);
    expect(within(screen.getByLabelText("Client")).getAllByRole("option").map((o) => o.textContent)).toEqual(["All clients", "Acme Ltd", "Zenith Ltd", "Dormant Ltd (inactive)"]);
  });

  it("paging and clearing the filters", async () => {
    mount(page([summary()], { total: 80 }), { page: 2, status: "paid", q: "x" });
    const u = user();
    await u.click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith("/invoices?q=x&status=paid&page=3");
    await u.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.push).toHaveBeenLastCalledWith("/invoices");
  });

  it("says what to do when there are none, and when a search finds none", () => {
    const { unmount } = mount(page([]));
    expect(screen.getByText(/No invoices yet/)).toBeTruthy();
    unmount();
    mount(page([]), { q: "zzz" });
    expect(screen.getByText("No invoices match these filters.")).toBeTruthy();
  });

  it("explains an unavailable service", () => {
    mount({ ok: false, reason: "unavailable" });
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});

describe("navigation", () => {
  it("has an Invoices link in the shared sidebar (the current page is highlighted from the address)", () => {
    render(<PortalShell admin={{ full_name: "Olivia Owner", email: "o@x.y" } as any} current="invoices" organization={{ name: "Acme", modules: ["inventory", "sales"] }}>{null}</PortalShell>);
    const link = screen.getByRole("link", { name: "Invoices" });
    expect(link.getAttribute("href")).toBe("/invoices");
    expect(screen.getByRole("link", { name: "Dispatches" }).getAttribute("href")).toBe("/dispatches");
  });
});

// =====================================================================================================
// The billing form
// =====================================================================================================
describe("New invoice: choosing the client", () => {
  it("offers only active clients and carries on to that client's dispatches", async () => {
    render(<InvoiceForm clients={clients as any} clientId="" billable={[]} invoice={null} />);
    expect(within(screen.getByLabelText("Client")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a client…", "Acme Ltd", "Zenith Ltd"]);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    await user().selectOptions(screen.getByLabelText("Client"), OTHER);
    await user().click(screen.getByRole("button", { name: "Continue" }));
    expect(router.push).toHaveBeenCalledWith(`/invoices/new?client=${OTHER}`);
    expect(calls).toHaveLength(0);
  });
  it("points to Clients when there is no active client", () => {
    render(<InvoiceForm clients={[clients[2]] as any} clientId="" billable={[]} invoice={null} />);
    expect(screen.getByText(/no active client/)).toBeTruthy();
  });
});

describe("New invoice: billing dispatched goods", () => {
  const mount = (props: Record<string, unknown> = {}) => render(<InvoiceForm clients={clients as any} clientId={CLIENT} billable={BILLABLE as any} invoice={null} {...props} />);
  const qtyOf = (name: string, d = "DS-000001") => screen.getByLabelText(`Quantity to bill of ${name} (${d})`) as HTMLInputElement;
  const priceOf = (name: string, d = "DS-000001") => screen.getByLabelText(`Selling price of ${name} (${d})`) as HTMLInputElement;
  const discountOf = (name: string, d = "DS-000001") => screen.getByLabelText(`Discount for ${name} (${d})`) as HTMLInputElement;
  const rateOf = (name: string, d = "DS-000001") => screen.getByLabelText(`Tax rate for ${name} (${d})`) as HTMLInputElement;
  const labelOf = (name: string, d = "DS-000001") => screen.getByLabelText(`Tax name for ${name} (${d})`) as HTMLInputElement;
  const totalsText = () => screen.getByLabelText("Invoice totals").textContent!;

  it("shows what was dispatched, what is invoiced, what sits in drafts and what is left, grouped by dispatch", () => {
    mount();
    const bolt = screen.getByTestId("bill-BOLT-1-DS-000001");
    for (const text of ["Steel bolt", "BOLT-1", "Dispatched", "Invoiced", "In drafts", "Left to bill", "10 pcs"]) expect(bolt.textContent, text).toContain(text);
    expect(screen.getByRole("link", { name: "DS-000001" }).getAttribute("href")).toBe(`/dispatches/${DISPATCH}`);
    expect(screen.getByTestId("bill-BOLT-1-DS-000002").textContent).toContain("Fully invoiced.");
    expect(screen.queryByRole("button", { name: /^Bill Steel bolt$/ })!.parentElement).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Bill / })).toHaveLength(2); // the fully invoiced line cannot be billed
    expect(screen.getByRole("note").textContent).toContain("never changes your stock");
  });

  it("never fills in a quantity or a price by itself", async () => {
    mount();
    await user().click(screen.getByRole("button", { name: "Bill Steel bolt" }));
    expect(qtyOf("Steel bolt").value).toBe("");
    expect(priceOf("Steel bolt").value).toBe("");
  });

  it("works out the line and the invoice totals exactly as you type", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Bill Steel bolt" }));
    await u.type(qtyOf("Steel bolt"), "10");
    await u.type(priceOf("Steel bolt"), "2.50");
    await u.type(discountOf("Steel bolt"), "1");
    await u.type(rateOf("Steel bolt"), "10");
    await u.type(labelOf("Steel bolt"), "VAT");
    expect(screen.getByTestId("amount-BOLT-1-DS-000001").textContent).toContain("Line total 26.40 USD");
    expect(screen.getByTestId("amount-BOLT-1-DS-000001").textContent).toContain("includes tax 2.40");
    await u.click(screen.getByRole("button", { name: "Bill Flour" }));
    await u.type(qtyOf("Flour"), "0.5");
    await u.type(priceOf("Flour"), "3.3333");
    expect(screen.getByTestId("amount-FLOUR-DS-000001").textContent).toContain("Line total 1.6667 USD"); // 1.66665 rounds half up
    const totals = totalsText();
    expect(totals).toContain("Subtotal26.6667"); // 25.00 + 1.6667
    expect(totals).toContain("Discount1.00");
    expect(totals).toContain("Tax2.40");
    expect(totals).toContain("Total28.0667");
  });

  it("'Bill all that is left' fills the exact remaining quantity, only when asked", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Bill Flour" }));
    await u.click(screen.getByRole("button", { name: "Bill all 2 kg that is left" }));
    expect(qtyOf("Flour").value).toBe("2");
  });

  it("removing a line takes it out of the totals", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Bill Steel bolt" }));
    await u.type(qtyOf("Steel bolt"), "4");
    await u.type(priceOf("Steel bolt"), "5");
    expect(totalsText()).toContain("Total20.00");
    await u.click(screen.getByRole("button", { name: "Remove Steel bolt (DS-000001) from the invoice" }));
    expect(totalsText()).toContain("Total0.00");
  });

  it("refuses an empty invoice, a missing price, too much quantity and a bad currency without calling the server", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    expect(screen.getByText("Choose at least one dispatched product to bill.")).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Bill Steel bolt" }));
    await u.type(qtyOf("Steel bolt"), "4");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    expect(screen.getByText("Enter a quantity and a price.")).toBeTruthy();
    await u.type(priceOf("Steel bolt"), "2");
    await u.clear(qtyOf("Steel bolt"));
    await u.type(qtyOf("Steel bolt"), "10.0001");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    expect(screen.getByText("Only 10 pcs of Steel bolt can still be billed from DS-000001.")).toBeTruthy();
    await u.clear(qtyOf("Steel bolt"));
    await u.type(qtyOf("Steel bolt"), "4");
    await u.type(discountOf("Steel bolt"), "9");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    expect(screen.getByText("The discount cannot be more than the line amount.")).toBeTruthy();
    await u.clear(discountOf("Steel bolt"));
    await u.clear(screen.getByLabelText(/Currency/));
    await u.type(screen.getByLabelText(/Currency/), "US");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    expect(screen.getByRole("alert").textContent).toContain("3-letter currency code");
    expect(calls).toHaveLength(0);
  });

  async function fill(u: ReturnType<typeof userEvent.setup>) {
    await u.click(screen.getByRole("button", { name: "Bill Steel bolt" }));
    await u.type(qtyOf("Steel bolt"), "10");
    await u.type(priceOf("Steel bolt"), "2.50");
    await u.type(discountOf("Steel bolt"), "1");
    await u.type(rateOf("Steel bolt"), "10");
    await u.type(labelOf("Steel bolt"), "VAT");
  }

  it("saves a DRAFT with exactly what was typed, an idempotency key and no stock call, then opens it for review", async () => {
    server["POST /api/sales/invoices"] = () => json(201, { invoice: draft(), replayed: false });
    mount();
    const u = user();
    await fill(u);
    await u.clear(screen.getByLabelText(/Currency/));
    await u.type(screen.getByLabelText(/Currency/), "eur");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/${INVOICE}`));
    const [post] = posts("/api/sales/invoices");
    expect(post.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(post.body).toMatchObject({
      clientId: CLIENT, currencyCode: "EUR", notes: "",
      lines: [{ dispatchLineId: BOLT_LINE, quantity: "10", unitPrice: "2.50", discountAmount: "1", taxRate: "10", taxLabel: "VAT" }],
    });
    expect(JSON.stringify(post.body)).not.toMatch(/organization|product|total|status|number/i);
    expect(stockCalls()).toEqual([]);
  });

  it("a double click saves one draft", async () => {
    let release: (r: Response) => void = () => undefined;
    server["POST /api/sales/invoices"] = () => new Promise<Response>((resolve) => { release = resolve; });
    mount();
    const u = user();
    await fill(u);
    const save = screen.getByRole("button", { name: "Save draft and review" });
    await u.dblClick(save);
    release(json(201, { invoice: draft(), replayed: false }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(posts("/api/sales/invoices")).toHaveLength(1);
  });

  it("a refused request gets a new key next time; a lost connection keeps the same one", async () => {
    let answer = () => json(409, { error: "You cannot bill 11 pcs of Steel bolt.", code: "over_invoiced" });
    server["POST /api/sales/invoices"] = () => answer();
    mount();
    const u = user();
    await fill(u);
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("You cannot bill 11 pcs"));
    answer = () => { throw new TypeError("network"); };
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to reach the server"));
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(posts("/api/sales/invoices")).toHaveLength(3));
    const keys = posts("/api/sales/invoices").map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).not.toBe(keys[1]); // the refused request was not accepted: the retry is a new request
    expect(keys[1]).toBe(keys[2]); // the lost connection might have succeeded: the retry must be the same request
    expect(router.push).not.toHaveBeenCalled();
  });

  it("sends a signed-out user to the login page", async () => {
    server["POST /api/sales/invoices"] = () => json(401, { error: "Your session has expired. Please sign in again." });
    mount();
    const u = user();
    await fill(u);
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("says so when the client has no confirmed dispatch", () => {
    mount({ billable: [] });
    expect(screen.getByText(/no confirmed dispatch to bill/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save draft and review" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Edit a draft invoice", () => {
  const mount = () => render(<InvoiceForm clients={[]} clientId={CLIENT} billable={BILLABLE as any} invoice={draft({ notes: "Net 30" }) as any} />);

  it("is filled in from the draft, with the currency fixed", () => {
    mount();
    expect((screen.getByLabelText("Quantity to bill of Steel bolt (DS-000001)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Selling price of Steel bolt (DS-000001)") as HTMLInputElement).value).toBe("2.5");
    expect((screen.getByLabelText("Discount for Steel bolt (DS-000001)") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Tax rate for Steel bolt (DS-000001)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Tax name for Steel bolt (DS-000001)") as HTMLInputElement).value).toBe("VAT");
    expect((screen.getByLabelText(/Currency/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("no invoice number until it is issued");
    expect(screen.getByLabelText("Invoice totals").textContent).toContain("Total26.40");
  });

  it("saves the changed header and then the lines of THIS draft", async () => {
    server["PATCH /api/sales/invoices/:id"] = () => json(200, { invoice: draft() });
    server["PUT /api/sales/invoices/:id/lines"] = () => json(200, { invoice: draft() });
    mount();
    const u = user();
    await u.clear(screen.getByLabelText("Quantity to bill of Steel bolt (DS-000001)"));
    await u.type(screen.getByLabelText("Quantity to bill of Steel bolt (DS-000001)"), "6");
    await u.clear(screen.getByLabelText("Notes"));
    await u.type(screen.getByLabelText("Notes"), "Net 45");
    await u.click(screen.getByRole("button", { name: "Save draft and review" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/invoices/${INVOICE}`));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/api/sales/invoices/${INVOICE}`);
    expect(patch.body).toMatchObject({ notes: "Net 45" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/sales/invoices/${INVOICE}/lines`);
    expect(put.body.lines).toEqual([{ dispatchLineId: BOLT_LINE, quantity: "6", unitPrice: "2.5", discountAmount: "1", taxRate: "10", taxLabel: "VAT" }]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(stockCalls()).toEqual([]);
  });
});

// =====================================================================================================
// One invoice
// =====================================================================================================
describe("Invoice: reading it", () => {
  it("shows the parties, dates, line detail with its dispatch, and the exact totals", () => {
    render(<InvoiceDetailView invoice={partial() as any} />);
    for (const text of ["INV-000001", "Partially paid", "Alpha Trading", "Acme Ltd", "1 Main St", "2026-11-01", "2999-01-01", "Steel bolt", "BOLT-1", "from DS-000001 (10)", "VAT 10%", "does not certify"]) {
      expect(document.body.textContent, text).toContain(text);
    }
    const totals = screen.getByLabelText("Totals").textContent!;
    for (const text of ["Subtotal25.00 USD", "Discount1.00 USD", "Tax2.40 USD", "Total26.40 USD", "Paid10.00 USD", "Outstanding16.40 USD"]) expect(totals, text).toContain(text);
  });

  it("prints, downloads the PDF, and never changes stock", async () => {
    window.print = vi.fn();
    render(<InvoiceDetailView invoice={issued() as any} />);
    await user().click(screen.getByRole("button", { name: "Print" }));
    expect(window.print).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("link", { name: "Download PDF" });
    expect(link.getAttribute("href")).toBe(`/api/sales/invoices/${INVOICE}/pdf`);
    expect(link.hasAttribute("download")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("the action areas are hidden when printing", () => {
    const { container } = render(<InvoiceDetailView invoice={issued() as any} />);
    for (const form of [screen.getByRole("form", { name: "Record a payment" }), screen.getByRole("region", { name: "Invoice actions" })]) expect(form.className).toContain("print:hidden");
    expect(container.querySelector("article")).toBeTruthy();
  });

  it("a void invoice is marked and offers nothing to do", () => {
    render(<InvoiceDetailView invoice={issued({ status: "void", void_reason: "wrong client", can_void: false, can_record_payment: false }) as any} />);
    expect(screen.getByText("VOID")).toBeTruthy();
    expect(document.body.textContent).toContain("wrong client");
    for (const name of ["Issue invoice", "Void invoice", "Record payment"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("flags an overdue invoice", () => {
    render(<InvoiceDetailView invoice={issued({ overdue: true, due_date: "2025-01-31" }) as any} />);
    expect(screen.getByText("Overdue")).toBeTruthy();
  });
});

describe("Invoice: issuing and discarding", () => {
  it("issuing asks first, then freezes the invoice and shows its number", async () => {
    server["POST /api/sales/invoices/:id/issue"] = () => json(200, { invoice: issued({ number: "INV-000007" }) });
    render(<InvoiceDetailView invoice={draft() as any} />);
    expect(screen.getByText("Draft invoice")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Record a payment" })).toBeNull();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Issue invoice" }));
    expect(calls).toHaveLength(0); // asking is not doing
    expect(within(screen.getByRole("group", { name: "Confirm issuing" })).getByText(/Stock is not touched/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Yes, issue it" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("INV-000007 issued"));
    expect(posts("/issue")).toHaveLength(1);
    expect(screen.getByText("INV-000007")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Edit draft" })).toBeNull();
    expect(screen.getByRole("form", { name: "Record a payment" })).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
    expect(stockCalls()).toEqual([]);
  });

  it("shows the service's refusal when the goods were billed elsewhere meanwhile", async () => {
    server["POST /api/sales/invoices/:id/issue"] = () => json(409, { error: "Steel bolt: 10 pcs were dispatched and 10 are already on issued invoices.", code: "over_invoiced" });
    render(<InvoiceDetailView invoice={draft() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Issue invoice" }));
    await u.click(screen.getByRole("button", { name: "Yes, issue it" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already on issued invoices"));
    expect(screen.getByText("Draft invoice")).toBeTruthy();
  });

  it("a draft is discarded with a confirmation and no reason", async () => {
    server["POST /api/sales/invoices/:id/void"] = () => json(200, { invoice: draft({ status: "void", editable: false, can_issue: false, can_void: false }) });
    render(<InvoiceDetailView invoice={draft() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Discard draft" }));
    await u.click(screen.getByRole("button", { name: "Yes, discard it" }));
    await waitFor(() => expect(posts("/void")).toHaveLength(1));
    expect(posts("/void")[0].body).toEqual({ reason: "" });
    await waitFor(() => expect(screen.getByText("VOID")).toBeTruthy());
  });
});

describe("Invoice: voiding an issued invoice", () => {
  it("needs a reason", async () => {
    server["POST /api/sales/invoices/:id/void"] = () => json(200, { invoice: issued({ status: "void", void_reason: "issued to the wrong client", can_void: false, can_record_payment: false }) });
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Void invoice" }));
    const confirm = screen.getByRole("button", { name: "Yes, void it" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await u.type(within(screen.getByRole("group", { name: "Confirm voiding" })).getByLabelText("Reason"), "issued to the wrong client");
    expect(confirm.disabled).toBe(false);
    await u.click(confirm);
    await waitFor(() => expect(posts("/void")).toHaveLength(1));
    expect(posts("/void")[0].body).toEqual({ reason: "issued to the wrong client" });
    await waitFor(() => expect(screen.getByText("VOID")).toBeTruthy());
  });

  it("an invoice with payments cannot be voided: it says to reverse the payments first", () => {
    render(<InvoiceDetailView invoice={partial() as any} />);
    expect(screen.queryByRole("button", { name: "Void invoice" })).toBeNull();
    expect(screen.getByText(/has payments on record, so it cannot be voided/)).toBeTruthy();
  });

  it("shows the service's refusal if payments appeared meanwhile", async () => {
    server["POST /api/sales/invoices/:id/void"] = () => json(409, { error: "INV-000001 has payments on record and cannot be voided.", code: "has_payments" });
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Void invoice" }));
    await u.type(screen.getByLabelText("Reason"), "oops");
    await u.click(screen.getByRole("button", { name: "Yes, void it" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("has payments on record"));
  });
});

describe("Invoice: recording payments", () => {
  const form = () => screen.getByRole("form", { name: "Record a payment" });
  const amount = () => within(form()).getByLabelText("Payment amount") as HTMLInputElement;

  it("records a partial payment, shows the new balance and the history, and clears the form", async () => {
    server["POST /api/sales/invoices/:id/payments"] = () => json(201, { invoice: partial(), replayed: false });
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.type(amount(), "10");
    await u.selectOptions(within(form()).getByLabelText("Payment method"), "cash");
    await u.type(within(form()).getByLabelText("Payment reference"), "RCPT-1");
    await u.click(within(form()).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Payment recorded."));
    const [post] = posts("/payments");
    expect(post.url).toBe(`/api/sales/invoices/${INVOICE}/payments`);
    expect(post.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(post.body).toMatchObject({ amount: "10", method: "cash", reference: "RCPT-1" });
    expect(JSON.stringify(post.body)).not.toMatch(/currency|organization|recorded|status/i);
    expect(screen.getByLabelText("Totals").textContent).toContain("Outstanding16.40 USD");
    expect(screen.getByText("Partially paid")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Payments" })).getByText("RCPT-1")).toBeTruthy();
    expect(amount().value).toBe("");
    expect(stockCalls()).toEqual([]);
  });

  it("refuses an empty, zero, negative or over-long amount and any payment above what is due, without a request", async () => {
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    for (const [typed, message] of [["", "Enter the amount received"], ["0", "Enter the amount received"], ["-5", "Enter the amount received"], ["1.00001", "Enter the amount received"], ["26.4001", "more than the 26.40 USD still due"]] as const) {
      await u.clear(amount());
      if (typed) await u.type(amount(), typed);
      await u.click(within(form()).getByRole("button", { name: "Record payment" }));
      expect(within(form()).getByRole("alert").textContent, typed).toContain(message);
    }
    expect(within(form()).getByRole("alert").textContent).toContain("No credit balance is held");
    expect(calls).toHaveLength(0);
  });

  it("'Pay the full amount still due' fills the exact outstanding amount", async () => {
    render(<InvoiceDetailView invoice={partial() as any} />);
    await user().click(within(form()).getByRole("button", { name: "Pay the full 16.40 USD still due" }));
    expect(amount().value).toBe("16.4");
  });

  it("a double click records one payment; the next payment is a new request", async () => {
    let release: (r: Response) => void = () => undefined;
    server["POST /api/sales/invoices/:id/payments"] = () => new Promise<Response>((resolve) => { release = resolve; });
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.type(amount(), "10");
    await u.dblClick(within(form()).getByRole("button", { name: "Record payment" }));
    release(json(201, { invoice: partial(), replayed: false }));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(posts("/payments")).toHaveLength(1);
    server["POST /api/sales/invoices/:id/payments"] = () => json(201, { invoice: partial({ paid_total: "20.0000", outstanding: "6.4000" }), replayed: false });
    await u.type(amount(), "10");
    await u.click(within(form()).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(posts("/payments")).toHaveLength(2));
    const [first, second] = posts("/payments").map((c) => c.headers["Idempotency-Key"]);
    expect(first).not.toBe(second);
  });

  it("a lost connection retries with the SAME key so nothing is recorded twice; a refusal does not", async () => {
    let answer = () => { throw new TypeError("network"); };
    server["POST /api/sales/invoices/:id/payments"] = () => answer() as any;
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.type(amount(), "10");
    await u.click(within(form()).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to reach the server"));
    answer = () => json(200, { invoice: partial(), replayed: true }) as any;
    await u.click(within(form()).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("had already been recorded"));
    const keys = posts("/payments").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows the service's refusal of an overpayment", async () => {
    server["POST /api/sales/invoices/:id/payments"] = () => json(409, { error: "10.00 USD is more than the 5.00 USD still due. No credit balance is held.", code: "overpayment" });
    render(<InvoiceDetailView invoice={issued() as any} />);
    const u = user();
    await u.type(amount(), "10");
    await u.click(within(form()).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("still due"));
    expect(screen.getByLabelText("Totals").textContent).toContain("Paid0.00 USD");
  });

  it("a paid invoice has no payment form", () => {
    render(<InvoiceDetailView invoice={issued({ status: "paid", paid_total: "26.4000", outstanding: "0.0000", can_record_payment: false, can_void: false, payments: [payment({ amount: "26.4000" })] }) as any} />);
    expect(screen.queryByRole("form", { name: "Record a payment" })).toBeNull();
    expect(screen.getByText("RCPT-1")).toBeTruthy();
  });

  it("says plainly that payments are manual and permanent", () => {
    render(<InvoiceDetailView invoice={issued() as any} />);
    expect(within(form()).getByText(/recorded by hand/).textContent).toContain("corrected with a reversal");
  });
});

describe("Invoice: reversing a payment", () => {
  const reversed = () => partial({
    status: "issued", paid_total: "0.0000", outstanding: "26.4000", can_void: true,
    payments: [payment({ reversed: true }), payment({ id: "99999999-0000-4000-8000-000000000002", kind: "reversal", reverses_payment_id: PAYMENT, notes: "recorded twice", reference: "RCPT-1" })],
  });

  it("needs a reason, keeps both records, and brings the balance back", async () => {
    server["POST /api/sales/invoices/:id/payments/:id/reverse"] = () => json(201, { invoice: reversed(), replayed: false });
    render(<InvoiceDetailView invoice={partial() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reverse the payment of 10.00 on 2026-11-05" }));
    const group = screen.getByRole("group", { name: "Reverse payment" });
    expect(group.textContent).toContain("never deleted");
    await u.click(within(group).getByRole("button", { name: "Reverse this payment" }));
    expect(within(group).getByRole("alert").textContent).toContain("Give the reason");
    expect(calls).toHaveLength(0);
    await u.type(within(group).getByLabelText("Reason"), "recorded twice");
    await u.click(within(group).getByRole("button", { name: "Reverse this payment" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Payment reversed"));
    const [post] = calls.filter((c) => c.url.endsWith("/reverse"));
    expect(post.url).toBe(`/api/sales/invoices/${INVOICE}/payments/${PAYMENT}/reverse`);
    expect(post.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    expect(post.body).toEqual({ reason: "recorded twice" });
    const history = within(screen.getByRole("region", { name: "Payments" }));
    expect(history.getByText("Reversed")).toBeTruthy();
    expect(history.getByText(/Reversal — recorded twice/)).toBeTruthy();
    expect(screen.getByLabelText("Totals").textContent).toContain("Outstanding26.40 USD");
    expect(screen.queryByRole("button", { name: /^Reverse the payment/ })).toBeNull(); // each payment is reversed once
    expect(screen.getByRole("button", { name: "Void invoice" })).toBeTruthy(); // net zero again
  });

  it("'Keep it' closes the box without a request", async () => {
    render(<InvoiceDetailView invoice={partial() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reverse the payment of 10.00 on 2026-11-05" }));
    await u.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("group", { name: "Reverse payment" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("shows the service's refusal if it was already reversed", async () => {
    server["POST /api/sales/invoices/:id/payments/:id/reverse"] = () => json(409, { error: "That payment was already reversed.", code: "already_reversed" });
    render(<InvoiceDetailView invoice={partial() as any} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Reverse the payment of 10.00 on 2026-11-05" }));
    await u.type(screen.getByLabelText("Reason"), "x");
    await u.click(screen.getByRole("button", { name: "Reverse this payment" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already reversed"));
  });
});

describe("the dispatch page links to invoicing", () => {
  it("a confirmed dispatch offers to create an invoice for its client", () => {
    const dispatch = {
      id: DISPATCH, number: "DS-000001", status: "confirmed", delivery_list: { id: LIST, number: "DL-000001", status: "dispatched" }, client: acme, dispatch_date: "2026-11-05", tracking_reference: null,
      line_count: 0, created_by_email: "a@b.c", created_at: now, confirmed_at: now, confirmed_by_email: "a@b.c", cancelled_at: null, cancelled_by_email: null, updated_at: now,
      delivery_address: null, transport_details: null, notes: null, lines: [], posting: { attempts: 1, started_at: now, last_attempt_at: now, last_error: null }, inventory_operation_id: null,
      editable: false, stock_status: "not-needed", lines_exceeding_stock: 0, stock_notice: "x",
    };
    const { unmount } = render(<DispatchDetailView dispatch={dispatch as any} />);
    expect(screen.getByRole("link", { name: "Create invoice" }).getAttribute("href")).toBe(`/invoices/new?client=${CLIENT}`);
    unmount();
    render(<DispatchDetailView dispatch={{ ...dispatch, status: "draft", editable: true } as any} />);
    expect(screen.queryByRole("link", { name: "Create invoice" })).toBeNull();
  });
});

describe("A client's account", () => {
  const account = (extra: Record<string, unknown> = {}) => ({
    client: acme,
    balances: [
      { currency_code: "USD", invoiced: "26.4000", paid: "10.0000", outstanding: "16.4000", overdue: "0.0000" },
      { currency_code: "PKR", invoiced: "200.0000", paid: "0.0000", outstanding: "200.0000", overdue: "200.0000" },
    ],
    invoices: [summary(), summary({ id: "x2", number: null, status: "draft" })],
    payments: [{ ...payment(), invoice_number: "INV-000001" }, { ...payment({ id: "p2", kind: "reversal", notes: "bounced" }), invoice_number: "INV-000001" }],
    ...extra,
  });

  it("keeps each currency apart and flags what is overdue", () => {
    render(<ClientAccountView account={account() as any} />);
    const usd = screen.getByTestId("balance-USD").textContent!;
    const pkr = screen.getByTestId("balance-PKR").textContent!;
    expect(usd).toContain("16.40");
    expect(pkr).toContain("200.00");
    expect(usd).not.toContain("200.00");
    expect(document.body.textContent).toContain("Nothing is converted or added across currencies");
    expect(screen.getByTestId("balance-PKR").querySelector(".text-red-300")).toBeTruthy();
    expect(screen.getByTestId("balance-USD").querySelector(".text-red-300")).toBeNull();
  });

  it("lists invoices (a draft without a number) and payments (a reversal as a negative)", () => {
    render(<ClientAccountView account={account() as any} />);
    const invoices = within(screen.getByRole("region", { name: "Invoices" }));
    expect(invoices.getByRole("link", { name: "INV-000001" }).getAttribute("href")).toBe(`/invoices/${INVOICE}`);
    expect(invoices.getByText("Draft", { selector: "a" })).toBeTruthy();
    const payments = within(screen.getByRole("region", { name: "Recent payments" }));
    expect(payments.getByText(/RCPT-1/)).toBeTruthy();
    expect(payments.getByText(/Reversal — bounced/)).toBeTruthy();
    expect(payments.getAllByRole("row").some((r) => r.textContent!.includes("−10.00"))).toBe(true);
  });

  it("offers a new invoice only for an active client, and says when there is nothing yet", () => {
    const { unmount } = render(<ClientAccountView account={account() as any} />);
    expect(screen.getByRole("link", { name: "New invoice" }).getAttribute("href")).toBe(`/invoices/new?client=${CLIENT}`);
    unmount();
    render(<ClientAccountView account={account({ client: { ...acme, is_active: false }, balances: [], invoices: [], payments: [] }) as any} />);
    expect(screen.queryByRole("link", { name: "New invoice" })).toBeNull();
    expect(screen.getByText("Nothing has been invoiced to this client yet.")).toBeTruthy();
    expect(screen.getByText("No invoices yet.")).toBeTruthy();
    expect(screen.getByText("No payment has been recorded yet.")).toBeTruthy();
  });
});
