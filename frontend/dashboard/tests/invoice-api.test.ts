import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeSalesFailure } from "@/lib/sales";
import { formatMoney, lineAmounts, moneyExceeds, subtractMoney, sumMoney } from "@/lib/sales-browser";
import { checkCurrency, checkMoney, checkRate, parseInvoiceLines } from "@/lib/sales-routes";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/sales/invoices/route";
import { GET as getInvoice, PATCH as editInvoice } from "@/app/api/sales/invoices/[id]/route";
import { PUT as saveLines } from "@/app/api/sales/invoices/[id]/lines/route";
import { POST as invoiceAction } from "@/app/api/sales/invoices/[id]/[action]/route";
import { GET as invoicePdf } from "@/app/api/sales/invoices/[id]/pdf/route";
import { POST as recordPayment } from "@/app/api/sales/invoices/[id]/payments/route";
import { POST as reversePayment } from "@/app/api/sales/invoices/[id]/payments/[paymentId]/reverse/route";
import { GET as billableLines } from "@/app/api/sales/billable-lines/route";
import { GET as clientAccount } from "@/app/api/sales/clients/[id]/account/route";

const ID = "8c3e2a2c-3d4e-4f5a-8ab2-c3d4e5f60718";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const DLINE = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";
const TOKEN = "session-token-abc";
const SALES = "http://sales-service:8003";
const KEY = "ui-3f2b8c1e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, query = "", key }: { cookie?: string | null; query?: string; key?: string } = {}) =>
  new NextRequest(`http://localhost:3001/api/sales/x${query}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const sentBody = () => JSON.parse(upstream().init.body);
const params = (extra: Record<string, string> = {}) => ({ params: { id: ID, ...extra } });

beforeEach(() => {
  process.env.SALES_SERVICE_URL = SALES;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

// =====================================================================================================
// Exact money, in the browser, identical to the Sales Service and its database
// =====================================================================================================
describe("lineAmounts: the exact preview", () => {
  // The SAME vectors as the Sales Service tests (tests/test_invoices.py): halves round up, nothing goes through floating point.
  it.each([
    ["0.3333", "0.3333", "0", "0", ["0.1111", "0.1111", "0.0000", "0.1111"]],
    ["1.5", "0.1", "0.05", "7.5", ["0.1500", "0.1000", "0.0075", "0.1075"]],
    ["0.5", "0.0001", "0", "100", ["0.0001", "0.0001", "0.0001", "0.0002"]],
    ["1.9999", "99.9999", "10", "17.5", ["199.9898", "189.9898", "33.2482", "223.2380"]],
    ["1", "0.3333", "0.1111", "33.3333", ["0.3333", "0.2222", "0.0741", "0.2963"]],
    ["2", "49999999999999.9999", "0", "0", ["99999999999999.9998", "99999999999999.9998", "0.0000", "99999999999999.9998"]],
    ["1.5", "1.015", "0.005", "5", ["1.5225", "1.5175", "0.0759", "1.5934"]],
    ["1", "0", "0", "12", ["0.0000", "0.0000", "0.0000", "0.0000"]],
    ["10", "2.50", "1.00", "10", ["25.0000", "24.0000", "2.4000", "26.4000"]],
    ["0.5", "3.3333", "0", "0", ["1.6667", "1.6667", "0.0000", "1.6667"]],
    ["3", "0.3333", "0", "7.5", ["0.9999", "0.9999", "0.0750", "1.0749"]],
    ["2", "0.1", "0.05", "17.5", ["0.2000", "0.1500", "0.0263", "0.1763"]],
  ])("%s x %s, discount %s, tax %s%%", (q, p, d, r, expected) => {
    const out = lineAmounts(q, p, d, r);
    expect(out.ok).toBe(true);
    if (out.ok) expect([out.subtotal, out.net, out.tax, out.total]).toEqual(expected);
  });

  it("treats a blank discount and a blank rate as zero", () => {
    expect(lineAmounts("2", "5", "", "")).toEqual({ ok: true, subtotal: "10.0000", net: "10.0000", tax: "0.0000", total: "10.0000" });
  });

  it("a total that float arithmetic would get wrong stays exact", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(lineAmounts("1", "0.1", "0", "0")).toMatchObject({ ok: true, total: "0.1000" });
    const sum = sumMoney([lineAmounts("1", "0.1", "0", "0"), lineAmounts("1", "0.2", "0", "0")].map((l) => (l.ok ? l.total : "0")));
    expect(sum).toBe("0.3000");
  });

  it.each([
    ["no quantity", "", "5", "0", "0"], ["no price", "1", "", "0", "0"], ["an exponent", "1e3", "5", "0", "0"], ["a negative price", "1", "-5", "0", "0"],
    ["too many decimals", "1.00001", "5", "0", "0"], ["a tax rate over 100", "1", "5", "0", "100.0001"], ["a negative discount", "1", "5", "-1", "0"],
    ["a comma", "1,000", "5", "0", "0"], ["too many digits", "123456789012345", "5", "0", "0"],
  ])("refuses %s", (_name, q, p, d, r) => {
    expect(lineAmounts(q, p, d, r).ok).toBe(false);
  });

  it("refuses a discount larger than the line", () => {
    expect(lineAmounts("2", "5", "10.0001", "0")).toMatchObject({ ok: false });
    expect(lineAmounts("2", "5", "10", "0")).toMatchObject({ ok: true, total: "0.0000" });
  });
});

describe("money helpers", () => {
  it.each([["25.0000", "25.00"], ["1234.5", "1,234.50"], ["1.6667", "1.6667"], ["0.0000", "0.00"], ["-5.0000", "-5.00"], ["1234567.1200", "1,234,567.12"], ["26.4000", "26.40"], ["0.0001", "0.0001"], ["100", "100.00"]])(
    "formats %s as %s without rounding", (value, expected) => expect(formatMoney(value)).toBe(expected)
  );
  it("adds and subtracts exactly", () => {
    expect(sumMoney(["0.1", "0.2", "25"])).toBe("25.3000");
    expect(sumMoney([])).toBe("0.0000");
    expect(subtractMoney("25.0000", "10.0001")).toBe("14.9999");
    expect(subtractMoney("1", "2.5")).toBe("-1.5000");
  });
  it("compares exactly", () => {
    expect(moneyExceeds("25.0001", "25.0000")).toBe(true);
    expect(moneyExceeds("25", "25.0000")).toBe(false);
    expect(moneyExceeds("0.0001", "0")).toBe(true);
  });
});

describe("the checks shared by the routes", () => {
  it("checkMoney keeps exact strings", () => {
    expect(checkMoney(" 12.5 ", false)).toBe("12.5");
    expect(checkMoney("0", true)).toBe("0");
    expect(checkMoney("0.0000", false)).toBeNull();
    expect(checkMoney(10, true)).toBeNull();
    for (const bad of ["-1", "1e3", "1.00001", "", "abc", "1,5", "123456789012345"]) expect(checkMoney(bad, true)).toBeNull();
  });
  it("checkRate accepts 0 to 100 with up to 4 decimals", () => {
    for (const ok of ["0", "7.5", "100", "100.0000", "33.3333"]) expect(checkRate(ok)).toBe(ok);
    for (const bad of ["100.0001", "-1", "101", "1.00001", "abc", 5]) expect(checkRate(bad)).toBeNull();
  });
  it("checkCurrency wants three letters and upper-cases them", () => {
    expect(checkCurrency(" pkr ")).toBe("PKR");
    for (const bad of ["US", "USDD", "12A", "€€€", 5, ""]) expect(checkCurrency(bad)).toBeNull();
  });
});

const lineBody = (extra: Record<string, unknown> = {}) => ({ dispatchLineId: DLINE, quantity: "10", unitPrice: "2.50", discountAmount: "1", taxRate: "10", taxLabel: "VAT", ...extra });

describe("parseInvoiceLines", () => {
  it("keeps only the dispatch line, exact amounts and the tax label", () => {
    expect(parseInvoiceLines([lineBody({ productName: "x", unit: "box", organizationId: "evil", status: "paid", lineTotal: "1", total: "1" })])).toEqual({
      ok: true, lines: [{ dispatch_line_id: DLINE, quantity: "10", unit_price: "2.50", discount_amount: "1", tax_rate: "10", tax_label: "VAT" }],
    });
  });
  it("defaults a missing discount and rate to zero and leaves out an empty label", () => {
    expect(parseInvoiceLines([{ dispatchLineId: DLINE, quantity: "1", unitPrice: "0" }])).toEqual({
      ok: true, lines: [{ dispatch_line_id: DLINE, quantity: "1", unit_price: "0", discount_amount: "0", tax_rate: "0" }],
    });
  });
  it.each([
    ["not a list", "all"], ["a non-object line", [5]], ["a bad dispatch line id", [lineBody({ dispatchLineId: "x" })]], ["a numeric quantity", [lineBody({ quantity: 10 })]],
    ["a zero quantity", [lineBody({ quantity: "0" })]], ["a negative quantity", [lineBody({ quantity: "-1" })]], ["an exponent", [lineBody({ quantity: "1e3" })]],
    ["no price", [lineBody({ unitPrice: undefined })]], ["a negative price", [lineBody({ unitPrice: "-1" })]], ["a price with 5 decimals", [lineBody({ unitPrice: "1.00001" })]],
    ["a negative discount", [lineBody({ discountAmount: "-1" })]], ["a tax rate over 100", [lineBody({ taxRate: "100.1" })]], ["a long tax label", [lineBody({ taxLabel: "x".repeat(51) })]],
    ["501 lines", Array.from({ length: 501 }, () => lineBody())],
  ])("refuses %s", (_name, value) => {
    expect(parseInvoiceLines(value).ok).toBe(false);
  });
});

describe("failure mapping for invoices", () => {
  it("passes the invoicing codes through", () => {
    for (const code of ["over_invoiced", "overpayment", "has_payments", "already_reversed"]) {
      expect(describeSalesFailure({ status: 409, data: { detail: { message: "No.", code } } })).toMatchObject({ status: 409, code, message: "No." });
    }
  });
  it("maps invoice field names for the form", () => {
    const failure = describeSalesFailure({ status: 422, data: { detail: [{ loc: ["body", "lines", 0, "unit_price"], msg: "bad" }, { loc: ["body", "currency_code"], msg: "Value error, worse" }, { loc: ["body", "tax_rate"], msg: "rate" }] } });
    expect(failure.fieldErrors).toEqual({ unitPrice: "bad", currencyCode: "worse", taxRate: "rate" });
  });
});

// =====================================================================================================
// The routes
// =====================================================================================================
describe("invoices: listing", () => {
  it("passes the filters on with the caller's own token and nothing else", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    const res = await listInvoices(request("GET", undefined, {
      query: `?status=issued&paymentStatus=overdue&clientId=${CLIENT}&dateFrom=2026-01-01&dateTo=2026-02-01&q=%20acme%20&limit=500&offset=10&organization_id=evil`,
    }));
    expect(res.status).toBe(200);
    const url = new URL(upstream().url);
    expect(url.pathname).toBe("/api/v1/sales/invoices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "issued", payment_status: "overdue", client_id: CLIENT, date_from: "2026-01-01", date_to: "2026-02-01", q: "acme", limit: "200", offset: "10",
    });
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });
  it("drops unknown statuses and refuses bad ids and dates without calling the service", async () => {
    stub(() => json(200, { items: [], total: 0, limit: 50, offset: 0 }));
    await listInvoices(request("GET", undefined, { query: "?status=bogus&paymentStatus=bogus" }));
    expect(new URL(upstream().url).searchParams.has("status") || new URL(upstream().url).searchParams.has("payment_status")).toBe(false);
    fetchMock.mockClear();
    expect((await listInvoices(request("GET", undefined, { query: "?clientId=nope" }))).status).toBe(404);
    expect((await listInvoices(request("GET", undefined, { query: "?dateFrom=2026-13-45" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("needs a session", async () => {
    expect((await listInvoices(request("GET", undefined, { cookie: null }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("answers 503 when the Sales Service is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const res = await listInvoices(request("GET"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("unavailable");
  });
});

describe("invoices: creating a draft", () => {
  it("sends only the allowed fields, the caller's token and the idempotency key", async () => {
    stub(() => json(201, { id: ID, number: null, status: "draft" }));
    const res = await createInvoice(request("POST", {
      clientId: CLIENT, currencyCode: "eur", invoiceDate: "2026-11-01", dueDate: "2026-12-01", notes: " Net 30 ", lines: [lineBody({ productName: "x" })],
      organization_id: "evil", status: "issued", number: "INV-9", total: "1", paid_total: "1",
    }, { key: KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ invoice: { status: "draft" }, replayed: false });
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": KEY });
    expect(sentBody()).toEqual({
      client_id: CLIENT, currency_code: "EUR", invoice_date: "2026-11-01", due_date: "2026-12-01", notes: "Net 30",
      lines: [{ dispatch_line_id: DLINE, quantity: "10", unit_price: "2.50", discount_amount: "1", tax_rate: "10", tax_label: "VAT" }],
    });
  });
  it("leaves the dates out when blank so the service applies its defaults", async () => {
    stub(() => json(201, { id: ID }));
    await createInvoice(request("POST", { clientId: CLIENT, currencyCode: "USD", lines: [] }, { key: KEY }));
    expect(sentBody()).toEqual({ client_id: CLIENT, currency_code: "USD", notes: "", lines: [] });
  });
  it("a retry is reported as a replay", async () => {
    stub(() => json(200, { id: ID }));
    const res = await createInvoice(request("POST", { clientId: CLIENT, currencyCode: "USD" }, { key: KEY }));
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });
  it.each([
    ["no key", { clientId: CLIENT, currencyCode: "USD" }, undefined, 400],
    ["a bad key", { clientId: CLIENT, currencyCode: "USD" }, "short", 400],
    ["a bad client id", { clientId: "nope", currencyCode: "USD" }, KEY, 404],
    ["no currency", { clientId: CLIENT }, KEY, 400],
    ["a two-letter currency", { clientId: CLIENT, currencyCode: "US" }, KEY, 400],
    ["a bad date", { clientId: CLIENT, currencyCode: "USD", invoiceDate: "2026-13-45" }, KEY, 400],
    ["a bad due date", { clientId: CLIENT, currencyCode: "USD", dueDate: "tomorrow" }, KEY, 400],
    ["a bad quantity", { clientId: CLIENT, currencyCode: "USD", lines: [lineBody({ quantity: "1e3" })] }, KEY, 400],
    ["lines that are not a list", { clientId: CLIENT, currencyCode: "USD", lines: "all" }, KEY, 400],
    ["a long note", { clientId: CLIENT, currencyCode: "USD", notes: "x".repeat(2001) }, KEY, 400],
  ])("refuses %s without calling the service", async (_name, body, key, status) => {
    const res = await createInvoice(request("POST", body, { key }));
    expect(res.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("needs a JSON body and a session", async () => {
    expect((await createInvoice(new NextRequest("http://localhost:3001/x", { method: "POST", headers: { cookie: `impex_tenant_session=${TOKEN}`, "idempotency-key": KEY }, body: "x" }))).status).toBe(415);
    expect((await createInvoice(request("POST", "{bad", { key: KEY }))).status).toBe(400);
    expect((await createInvoice(request("POST", { clientId: CLIENT, currencyCode: "USD" }, { cookie: null, key: KEY }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("passes the service's refusals through", async () => {
    stub(() => json(409, { detail: { message: "You cannot bill 5 pcs of Steel bolt: 10 were dispatched and 6 are already on issued invoices, so at most 4 can still be billed.", code: "over_invoiced" } }));
    const res = await createInvoice(request("POST", { clientId: CLIENT, currencyCode: "USD", lines: [lineBody()] }, { key: KEY }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "over_invoiced", error: expect.stringContaining("at most 4") });
    stub(() => json(404, { detail: "Client not found." }));
    expect((await createInvoice(request("POST", { clientId: CLIENT, currencyCode: "USD" }, { key: KEY }))).status).toBe(404);
  });
});

describe("invoices: reading and editing a draft", () => {
  it("reads one", async () => {
    stub(() => json(200, { id: ID, status: "draft" }));
    const res = await getInvoice(request("GET"), params());
    expect(await res.json()).toEqual({ invoice: { id: ID, status: "draft" } });
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}`);
  });
  it("answers not found for a bad id and for another organization's (the service says 404)", async () => {
    expect((await getInvoice(request("GET"), { params: { id: "nope" } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => json(404, { detail: "Invoice not found." }));
    const res = await getInvoice(request("GET"), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Invoice not found.");
  });
  it("edits only the dates and the note", async () => {
    stub(() => json(200, { id: ID }));
    await editInvoice(request("PATCH", { invoiceDate: "2026-11-01", dueDate: "2026-12-01", notes: " hi ", total: "1", status: "paid", number: "x", organization_id: "evil" }), params());
    expect(sentBody()).toEqual({ invoice_date: "2026-11-01", due_date: "2026-12-01", notes: "hi" });
    expect(upstream().init.method).toBe("PATCH");
  });
  it.each([["a bad date", { invoiceDate: "x" }], ["a long note", { notes: "x".repeat(2001) }], ["nothing to change", {}], ["only unknown fields", { total: "1" }]])("refuses %s", async (_n, body) => {
    expect((await editInvoice(request("PATCH", body), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a frozen invoice's refusal reaches the browser", async () => {
    stub(() => json(409, { detail: "INV-000001 is issued. Only a draft invoice can be changed." }));
    const res = await editInvoice(request("PATCH", { notes: "x" }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Only a draft");
  });
  it("replaces the lines with exactly the parsed ones", async () => {
    stub(() => json(200, { id: ID }));
    await saveLines(request("PUT", { lines: [lineBody({ unit: "box", total: "5" })], organization_id: "evil" }), params());
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}/lines`);
    expect(sentBody()).toEqual({ lines: [{ dispatch_line_id: DLINE, quantity: "10", unit_price: "2.50", discount_amount: "1", tax_rate: "10", tax_label: "VAT" }] });
    fetchMock.mockClear();
    expect((await saveLines(request("PUT", { lines: [lineBody({ quantity: "0" })] }), params())).status).toBe(400);
    expect((await saveLines(request("PUT", { lines: "all" }), params())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("invoices: issuing and voiding", () => {
  it("issues with no body", async () => {
    stub(() => json(200, { id: ID, number: "INV-000001", status: "issued" }));
    const res = await invoiceAction(request("POST"), params({ action: "issue" }));
    expect(res.status).toBe(200);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}/issue`);
    expect(upstream().init.body).toBeUndefined();
  });
  it("voids with the reason, or with none for a draft", async () => {
    stub(() => json(200, { id: ID, status: "void" }));
    await invoiceAction(request("POST", { reason: " wrong client " }), params({ action: "void" }));
    expect(sentBody()).toEqual({ reason: "wrong client" });
    fetchMock.mockClear();
    await invoiceAction(request("POST"), params({ action: "void" }));
    expect(sentBody()).toEqual({ reason: null });
    fetchMock.mockClear();
    expect((await invoiceAction(request("POST", { reason: "x".repeat(501) }), params({ action: "void" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("knows only issue and void", async () => {
    for (const action of ["pay", "delete", "reopen", "../x"]) expect((await invoiceAction(request("POST"), params({ action }))).status).toBe(404);
    expect((await invoiceAction(request("POST"), { params: { id: "nope", action: "issue" } })).status).toBe(404);
    expect((await invoiceAction(request("POST", undefined, { cookie: null }), params({ action: "issue" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("tells the browser why an invoice with payments cannot be voided", async () => {
    stub(() => json(409, { detail: { message: "INV-000001 has payments on record and cannot be voided. Reverse the payments first.", code: "has_payments" } }));
    const res = await invoiceAction(request("POST", { reason: "x" }), params({ action: "void" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "has_payments" });
  });
});

describe("invoices: the PDF", () => {
  const pdf = () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="INV-000001.pdf"' } });
  it("hands the file to the browser as a download, never cached", async () => {
    stub(() => pdf());
    const res = await invoicePdf(request("GET"), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV-000001.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF-");
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}/pdf`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });
  it("passes on only a safe file name", async () => {
    stub(() => new Response("x", { status: 200, headers: { "Content-Disposition": 'attachment; filename="../../etc/passwd"' } }));
    expect((await invoicePdf(request("GET"), params())).headers.get("content-disposition")).toBe('attachment; filename="invoice.pdf"');
  });
  it("answers like the other routes when the invoice is missing, the session is gone or the service is down", async () => {
    stub(() => json(404, { detail: "Invoice not found." }));
    expect((await invoicePdf(request("GET"), params())).status).toBe(404);
    expect((await invoicePdf(request("GET", undefined, { cookie: null }), params())).status).toBe(401);
    expect((await invoicePdf(request("GET"), { params: { id: "nope" } })).status).toBe(404);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await invoicePdf(request("GET"), params())).status).toBe(503);
  });
});

describe("payments", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ amount: "10.50", method: "cash", paymentDate: "2026-11-05", reference: " RCPT  1 ", notes: "at the counter", ...extra });
  it("records only the allowed fields with the idempotency key", async () => {
    stub(() => json(201, { id: ID, status: "partially_paid" }));
    const res = await recordPayment(request("POST", body({ currencyCode: "EUR", recordedBy: "evil", invoiceId: "evil", organization_id: "evil", status: "paid" }), { key: KEY }), params());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ replayed: false });
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}/payments`);
    expect(upstream().init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "Idempotency-Key": KEY });
    expect(sentBody()).toEqual({ amount: "10.50", method: "cash", reference: "RCPT 1", notes: "at the counter", payment_date: "2026-11-05" });
  });
  it("a retry answers 200 and is flagged as a replay", async () => {
    stub(() => json(200, { id: ID }));
    const res = await recordPayment(request("POST", body(), { key: KEY }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });
  it.each([
    ["no key", body(), undefined, 400], ["a bad key", body(), "short", 400], ["a zero amount", body({ amount: "0" }), KEY, 400], ["a negative amount", body({ amount: "-5" }), KEY, 400],
    ["a numeric amount", body({ amount: 5 }), KEY, 400], ["too many decimals", body({ amount: "1.00001" }), KEY, 400], ["an exponent", body({ amount: "1e3" }), KEY, 400],
    ["an unknown method", body({ method: "bitcoin" }), KEY, 400], ["no method", body({ method: undefined }), KEY, 400], ["a bad date", body({ paymentDate: "soon" }), KEY, 400],
    ["a long reference", body({ reference: "x".repeat(101) }), KEY, 400], ["long notes", body({ notes: "x".repeat(501) }), KEY, 400],
  ])("refuses %s without calling the service", async (_name, payload, key, status) => {
    expect((await recordPayment(request("POST", payload, { key }), params())).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("explains an overpayment", async () => {
    stub(() => json(409, { detail: { message: "30.00 USD is more than the 25.00 USD still due on INV-000001. Payments above the outstanding amount are not accepted (no credit balance is held).", code: "overpayment" } }));
    const res = await recordPayment(request("POST", body({ amount: "30" }), { key: KEY }), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "overpayment", error: expect.stringContaining("no credit") });
  });
  it("needs a session and a real invoice id", async () => {
    expect((await recordPayment(request("POST", body(), { cookie: null, key: KEY }), params())).status).toBe(401);
    expect((await recordPayment(request("POST", body(), { key: KEY }), { params: { id: "nope" } })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reversing a payment", () => {
  const p = (extra: Record<string, string> = {}) => params({ paymentId: PAYMENT, ...extra });
  it("sends the reason with the idempotency key", async () => {
    stub(() => json(201, { id: ID }));
    const res = await reversePayment(request("POST", { reason: " recorded twice ", amount: "1", organization_id: "evil" }, { key: KEY }), p());
    expect(res.status).toBe(201);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/invoices/${ID}/payments/${PAYMENT}/reverse`);
    expect(upstream().init.headers).toMatchObject({ "Idempotency-Key": KEY });
    expect(sentBody()).toEqual({ reason: "recorded twice" });
  });
  it.each([["no reason", {}, KEY], ["a blank reason", { reason: "   " }, KEY], ["a long reason", { reason: "x".repeat(501) }, KEY], ["no key", { reason: "x" }, undefined]])("refuses %s", async (_n, payload, key) => {
    expect((await reversePayment(request("POST", payload, { key }), p())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("checks both ids and the session", async () => {
    expect((await reversePayment(request("POST", { reason: "x" }, { key: KEY }), { params: { id: ID, paymentId: "nope" } })).status).toBe(404);
    expect((await reversePayment(request("POST", { reason: "x" }, { key: KEY }), { params: { id: "nope", paymentId: PAYMENT } })).status).toBe(404);
    expect((await reversePayment(request("POST", { reason: "x" }, { cookie: null, key: KEY }), p())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("tells the browser a payment was already reversed", async () => {
    stub(() => json(409, { detail: { message: "That payment was already reversed. Both records stay on the invoice.", code: "already_reversed" } }));
    expect(await (await reversePayment(request("POST", { reason: "x" }, { key: KEY }), p())).json()).toMatchObject({ code: "already_reversed" });
  });
});

describe("billable lines and the client's account", () => {
  it("asks for one client's confirmed dispatch lines", async () => {
    stub(() => json(200, [{ dispatch_line_id: DLINE }]));
    const res = await billableLines(request("GET", undefined, { query: `?clientId=${CLIENT}&deliveryListId=${ID}&organization_id=evil` }));
    expect(await res.json()).toEqual({ lines: [{ dispatch_line_id: DLINE }] });
    expect(Object.fromEntries(new URL(upstream().url).searchParams)).toEqual({ client_id: CLIENT, delivery_list_id: ID });
  });
  it("refuses a missing or malformed client id without calling the service", async () => {
    expect((await billableLines(request("GET"))).status).toBe(404);
    expect((await billableLines(request("GET", undefined, { query: "?clientId=nope" }))).status).toBe(404);
    expect((await billableLines(request("GET", undefined, { query: `?clientId=${CLIENT}&deliveryListId=nope` }))).status).toBe(404);
    expect((await billableLines(request("GET", undefined, { cookie: null, query: `?clientId=${CLIENT}` }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reads the account", async () => {
    stub(() => json(200, { client: { id: CLIENT }, balances: [], invoices: [], payments: [] }));
    const res = await clientAccount(request("GET"), { params: { id: CLIENT } });
    expect((await res.json()).account.client.id).toBe(CLIENT);
    expect(upstream().url).toBe(`${SALES}/api/v1/sales/clients/${CLIENT}/account`);
    expect((await clientAccount(request("GET"), { params: { id: "nope" } })).status).toBe(404);
    expect((await clientAccount(request("GET", undefined, { cookie: null }), { params: { id: CLIENT } })).status).toBe(401);
  });
});
