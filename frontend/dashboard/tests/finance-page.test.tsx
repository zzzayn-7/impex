// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/finance" }));

import FinanceView from "@/app/finance/finance-view";
import { changeView, formatDay, signed, sourceHref, trendPoints } from "@/lib/finance-view";
import type { CurrencyBlock, FinanceHistory, FinanceSummary, HistoryRow } from "@/lib/finance";

// =====================================================================================================
// fixtures: what the Finance Service answers, exactly (money is always a string)
// =====================================================================================================
const flat = { absolute: "0.0000", percent: "0.0", state: "value" as const, direction: "flat" as const };
const up = (absolute: string, percent: string | null, state: "value" | "new" = "value") => ({ absolute, percent, state, direction: "up" as const });
const down = (absolute: string, percent: string) => ({ absolute, percent, state: "value" as const, direction: "down" as const });

const trend = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ at: `2026-11-0${n + 1}T10:00:00+00:00`, capital: n < 5 ? "5000000.0000" : "5400000.0000" }));

function block(over: Partial<CurrencyBlock> = {}, currency = "PKR"): CurrencyBlock {
  return {
    currency_code: currency,
    capital: { ready: true, basis: "owner_records", closing: "5400000.0000", opening: "5000000.0000", change: up("400000.0000", "8.0") },
    investment: { closing: "5000000.0000", opening: "5000000.0000", change: flat, contributions: "0.0000", withdrawals: "0.0000", net_invested: "0.0000", inventory_purchases: "5000000.0000" },
    profit_loss: { net: "350000.0000", gross_profit: "400000.0000", revenue: "2400000.0000", cost_of_goods_sold: "2000000.0000", expenses: "50000.0000", adjustments: "0.0000", needs_cost_count: 0, needs_cost_revenue: "0.0000" },
    trend, ...over,
  };
}
const summary = (over: Partial<FinanceSummary> = {}, period: "1w" | "1m" | "1y" = "1m"): FinanceSummary => ({
  period: { key: period, label: { "1w": "1 Week", "1m": "1 Month", "1y": "1 Year" }[period], start: "2026-10-11T10:00:00+00:00", end: "2026-11-11T10:00:00+00:00", timezone: "Asia/Karachi" },
  default_currency: "PKR", currencies: ["PKR"], combined_available: true, combined_note: null, setup_required: false, setup_message: null, has_opening_position: false,
  reconciliation: { needs_cost: 0, needs_price: 0, total: 0 }, by_currency: { PKR: block() }, ...over,
});

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  id: "x", kind: "sale", category: "profitable_sales", occurred_at: "2026-11-10T10:00:00+00:00", description: "20 x Dell Latitude Laptop - SO-000001", counterparty: "Company A", transaction: "Sale delivered",
  amount: "2400000.0000", profit_loss: "400000.0000", currency_code: "PKR", status: "recognized", reference: "DS-000001", notes: null, source_type: "dispatch", source_id: "d1", affects_capital: true,
  can_reverse: false, delivery_id: "dl1", direction: null, ...over,
});
const ROWS: HistoryRow[] = [
  row({ id: "capital:1", kind: "owner_contribution", category: "investments", description: "Seed money", counterparty: null, transaction: "Owner contribution", amount: "5000000.0000", profit_loss: null, status: null, reference: null,
        source_type: "capital_record", source_id: "c1", can_reverse: true, delivery_id: null, direction: "in" }),
  row({ id: "cost:1", kind: "inventory_purchase", category: "investments", description: "50 x Dell Latitude Laptop bought", counterparty: "Acme Supplies", transaction: "Inventory purchase", amount: "5000000.0000",
        profit_loss: null, status: null, reference: "GR-000001", notes: "Purchase order PO-000001", source_type: "goods_receipt", source_id: "g1", affects_capital: false, delivery_id: null, direction: "exchange" }),
  row({ id: "delivery:1" }),
  row({ id: "delivery:2", category: "loss_sales", description: "5 x HP Monitor - SO-000002", counterparty: "Company B", amount: "100000.0000", profit_loss: "-20000.0000", source_id: "d2", delivery_id: "dl2" }),
  row({ id: "delivery:3", category: "reconciliation", description: "10 x Cisco Router - SO-000003", counterparty: "Company C", transaction: "Sale delivered - needs cost reconciliation", amount: "500000.0000", profit_loss: null,
        status: "needs_cost", source_id: "d3", delivery_id: "dl3" }),
  row({ id: "expense:1", kind: "expense", category: "expenses_adjustments", description: "Warehouse rent", counterparty: "Landlord", transaction: "Expense", amount: "50000.0000", profit_loss: "-50000.0000", status: null, reference: "EXP-000001",
        source_type: "expense", source_id: "e1", delivery_id: null }),
];
const history = (items = ROWS, over: Partial<FinanceHistory> = {}): FinanceHistory => ({ items, total: items.length, limit: 25, offset: 0, period: { key: "1m", label: "1 Month", start: "2026-10-11T10:00:00+00:00", end: "2026-11-11T10:00:00+00:00" }, ...over });

const CATEGORIES = [{ id: "acc-1", code: "5000", name: "General Expenses", account_type: "expense", description: null, is_active: true, is_system: false, system_key: null, has_postings: false, created_at: "", updated_at: "" }] as any;

// =====================================================================================================
// a stand-in for the portal's own routes
// =====================================================================================================
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; init: any };
let calls: Call[] = [];
let handler: (url: string, init: any) => Response | Promise<Response> | undefined;
const byUrl = (part: string) => calls.filter((c) => c.url.includes(part));
const bodyOf = (call: Call) => JSON.parse(call.init.body);
const keyOf = (call: Call) => (call.init.headers ?? {})["Idempotency-Key"];

function stubRoutes(overrides: Record<string, (url: string, init: any) => Response | Promise<Response>> = {}, current: () => FinanceSummary = () => summary()) {
  calls = [];
  handler = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [part, fn] of Object.entries(overrides)) if (url.includes(part)) return fn(url, init);
    if (url.startsWith("/api/finance/summary")) { const p = new URL(url, "http://x").searchParams.get("period") as any; return json(200, { ...current(), period: { ...current().period, key: p, label: { "1w": "1 Week", "1m": "1 Month", "1y": "1 Year" }[p as "1w"] } }); }
    if (url.startsWith("/api/finance/history")) return json(200, history());
    if (url.startsWith("/api/finance/opening-positions")) return json(200, { items: [] });
    if (url.startsWith("/api/finance/inventory-costs")) return json(200, { items: [] });
    if (url.startsWith("/api/finance/reconciliation")) return json(200, { items: [] });
    return json(200, {});
  }));
}

function mount(over: { summary?: FinanceSummary; history?: FinanceHistory } = {}) {
  return render(<FinanceView initialSummary={over.summary ?? summary()} initialHistory={over.history ?? history()} expenseCategories={CATEGORIES} />);
}

beforeEach(() => {
  router.replace.mockReset();
  stubRoutes();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =====================================================================================================
describe("the Finance Overview", () => {
  it("has the title, the subtitle and the three summary cards", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Finance Overview" })).toBeTruthy();
    expect(screen.getByText("Track your business capital, investments, and trading performance.")).toBeTruthy();
    for (const name of ["Capital", "Investment", "Profit and Loss"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.getByTestId("capital-value").textContent).toBe("PKR 5,400,000.00");
    expect(screen.getByTestId("investment-value").textContent).toBe("PKR 5,000,000.00");
    expect(screen.getByTestId("pnl-value").textContent).toBe("PKR +350,000.00");
    expect(screen.getByTestId("pnl-gross").textContent).toBe("+400,000.00");
    expect(screen.getByTestId("pnl-expenses").textContent).toBe("-50,000.00");
  });

  it("has exactly 1 Week | 1 Month | 1 Year, in that order, with the month selected", () => {
    mount();
    const group = screen.getByRole("radiogroup", { name: "Period" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["1 Week", "1 Month", "1 Year"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("the sidebar-less page shows none of the old Finance pages as its own navigation", () => {
    mount();
    for (const gone of ["Financial Overview", "Journal Entries"]) expect(screen.queryByText(gone)).toBeNull();
    const records = screen.getByRole("navigation", { name: "Accounting records" });
    expect(within(records).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/finance/accounting", "/finance/expenses", "/finance/journal", "/finance/accounts"]); // kept for compatibility
  });

  it("choosing a period asks for exactly that period and replaces every figure", async () => {
    const week = summary({ by_currency: { PKR: block({ capital: { ready: true, basis: "owner_records", closing: "5100000.0000", opening: "5000000.0000", change: up("100000.0000", "2.0") } }) } }, "1w");
    stubRoutes({}, () => week);
    mount();
    await userEvent.click(screen.getByRole("radio", { name: "1 Week" }));
    await waitFor(() => expect(screen.getByTestId("capital-value").textContent).toBe("PKR 5,100,000.00"));
    expect(screen.getByRole("radio", { name: "1 Week" }).getAttribute("aria-checked")).toBe("true");
    expect(byUrl("/api/finance/summary").at(-1)!.url).toBe("/api/finance/summary?period=1w");
    expect(byUrl("/api/finance/history").at(-1)!.url).toContain("period=1w");
    expect(screen.getByTestId("capital-change").textContent).toContain("+2.0%");
  });

  it("shows an increase, a decrease, no change and a zero baseline the way the specification says - never a percentage of zero", () => {
    const view = (change: any) => changeView(change, "PKR");
    expect(view(up("500000.0000", "50.0"))).toMatchObject({ arrow: "▲", label: "+50.0%", absolute: "+500,000.00 PKR" });
    expect(view(down("-250000.0000", "-25.0"))).toMatchObject({ arrow: "▼", label: "-25.0%", absolute: "-250,000.00 PKR" });
    expect(view(flat)).toMatchObject({ arrow: "▬", label: "0.0%", absolute: "0.00 PKR" });
    expect(view(up("5000000.0000", null, "new"))).toMatchObject({ arrow: "▲", label: "New", absolute: "+5,000,000.00 PKR" });
    expect(view(up("5", null, "new")).label).not.toMatch(/Infinity|NaN|%/);
    expect(view(down("-1", "-0.1")).tone).toContain("red");
    expect(view(up("1", "0.1")).tone).toContain("emerald");
  });

  it("renders those changes on the cards, with the arrow, the colour class and the absolute amount", () => {
    mount({ summary: summary({ by_currency: { PKR: block({ capital: { ready: true, basis: "owner_records", closing: "5000000.0000", opening: "0.0000", change: up("5000000.0000", null, "new") },
      investment: { closing: "4000000.0000", opening: "5000000.0000", change: down("-1000000.0000", "-20.0"), contributions: "0.0000", withdrawals: "1000000.0000", net_invested: "-1000000.0000", inventory_purchases: "0.0000" } }) } }) });
    expect(screen.getByTestId("capital-change").textContent).toBe("▲New(+5,000,000.00 PKR)");
    expect(screen.getByTestId("investment-change").textContent).toBe("▼-20.0%(-1,000,000.00 PKR)");
    expect(screen.getByTestId("investment-change").className).toContain("text-red-300");
    expect(screen.getByTestId("investment-withdrawals").textContent).toBe("-1,000,000.00");
    expect(screen.queryByTestId("inventory-activity-link")).toBeNull(); // nothing was bought
  });

  it("a loss is red with a minus sign, and a zero result is neutral", () => {
    mount({ summary: summary({ by_currency: { PKR: block({ profit_loss: { net: "-200000.0000", gross_profit: "-200000.0000", revenue: "1.0000", cost_of_goods_sold: "1.0000", expenses: "0.0000", adjustments: "0.0000", needs_cost_count: 0, needs_cost_revenue: "0.0000" } }) } }) });
    expect(screen.getByTestId("pnl-value").textContent).toBe("PKR -200,000.00");
    expect(screen.getByTestId("pnl-value").className).toContain("text-red-300");
  });

  it("the inventory investment link scopes the history to investments", async () => {
    mount();
    await userEvent.click(screen.getByTestId("inventory-activity-link"));
    await waitFor(() => expect(byUrl("/api/finance/history").at(-1)!.url).toContain("category=investments"));
    expect(screen.getByRole("button", { name: "Investments", pressed: true })).toBeTruthy();
    expect(byUrl("/api/finance/summary")).toHaveLength(0); // only the history was asked for
  });
});

describe("when capital cannot be established", () => {
  const none = summary({ currencies: [], setup_required: true, setup_message: "Capital cannot be calculated yet. Set up your opening position or record an owner contribution - no starting balance is assumed.", by_currency: {} });

  it("says Setup required instead of showing a figure, and shows no trend", () => {
    mount({ summary: none, history: history([]) });
    expect(screen.getByTestId("capital-setup").textContent).toContain("Setup required");
    expect(screen.queryByTestId("capital-value")).toBeNull();
    expect(screen.getByText(/The capital trend appears once capital can be calculated/)).toBeTruthy();
    expect(screen.getByTestId("setup-banner").textContent).toContain("no starting balance is assumed");
    expect(screen.getByTestId("investment-value").textContent).toBe("PKR 0.00"); // nothing invested is zero, not a made-up amount
    expect(screen.getByText(/No transactions in this period/)).toBeTruthy();
  });

  it("offers the opening position and an owner contribution right there", async () => {
    mount({ summary: none, history: history([]) });
    const banner = screen.getByTestId("setup-banner");
    await userEvent.click(within(banner).getByRole("button", { name: "Record contribution" }));
    expect(screen.getByRole("dialog", { name: "Record Investment" })).toBeTruthy();
  });
});

describe("several currencies", () => {
  const multi = summary({
    currencies: ["PKR", "USD"], combined_available: false, combined_note: "Records exist in more than one currency and Impex holds no exchange rates, so each currency is reported on its own and a combined figure is not available.",
    by_currency: { PKR: block(), USD: block({ capital: { ready: true, basis: "owner_records", closing: "20000.0000", opening: "20000.0000", change: flat } }, "USD") },
  });

  it("reports each currency on its own, says no combined figure exists and never adds them", async () => {
    mount({ summary: multi });
    expect(screen.getByTestId("currency-note").textContent).toContain("a combined figure is not available");
    expect(screen.getByTestId("capital-value").textContent).toBe("PKR 5,400,000.00");
    await userEvent.click(screen.getByRole("tab", { name: "USD" }));
    expect(screen.getByTestId("capital-value").textContent).toBe("USD 20,000.00");
    expect(document.body.textContent).not.toContain("5,420,000"); // PKR + USD must never appear
    await waitFor(() => expect(byUrl("/api/finance/history").at(-1)!.url).toContain("currency=USD"));
  });

  it("shows no currency switcher when there is only one", () => {
    mount();
    expect(screen.queryByRole("tablist", { name: "Currency" })).toBeNull();
  });
});

describe("the trend", () => {
  it("is one minimal line with a text alternative", () => {
    mount();
    const chart = screen.getByRole("img", { name: /Capital from PKR 5,000,000.00 on .* to PKR 5,400,000.00 on / });
    expect(chart.querySelectorAll("polyline")).toHaveLength(1);
    expect(chart.getAttribute("class")).toContain("text-ix-accent"); // the theme's accent, whatever it is
  });

  it("draws a flat line for an unchanged capital and nothing for too few points", () => {
    expect(trendPoints([{ at: "a", capital: "5.0000" }, { at: "b", capital: "5.0000" }], 600, 150).flat).toBe(true);
    expect(trendPoints([{ at: "a", capital: "5.0000" }], 600, 150).line).toBe("");
    const { line } = trendPoints(trend, 600, 150);
    expect(line.split(" ")).toHaveLength(8);
  });
});

describe("reconciliation", () => {
  it("is announced, with the reason it is not in the profit", () => {
    mount({ summary: summary({ reconciliation: { needs_cost: 1, needs_price: 1, total: 2 }, by_currency: { PKR: block({ profit_loss: { ...block().profit_loss, needs_cost_count: 1, needs_cost_revenue: "500000.0000" } }) } }) });
    expect(screen.getByTestId("reconciliation-banner").textContent).toContain("2 deliveries need reconciliation");
    expect(screen.getByTestId("reconciliation-banner").textContent).toContain("never assumes a cost of zero");
    expect(screen.getByRole("region", { name: "Profit and Loss" }).textContent).toContain("1 delivery needs cost reconciliation and is not included");
  });

  it("has no banner when everything is reconciled", () => {
    mount();
    expect(screen.queryByTestId("reconciliation-banner")).toBeNull();
  });

  it("lists the waiting deliveries and settles one by hand", async () => {
    const item = { delivery_id: "dl3", status: "needs_cost", delivered_at: "2026-11-10T10:00:00+00:00", dispatch_number: "DS-000003", order_number: "SO-000003", client_name: "Company C", product_id: "p1", sku: "CIS-1", name: "Cisco Router",
      quantity: "10.0000", currency_code: "PKR", unit_price: "50000.0000", revenue: "500000.0000", note: "No reliable cost" };
    stubRoutes({ "/api/finance/reconciliation": () => json(200, { items: [item] }), "/api/finance/deliveries/dl3/reconcile": () => json(200, { delivery: { status: "recognized" } }) });
    mount({ summary: summary({ reconciliation: { needs_cost: 1, needs_price: 0, total: 1 } }) });
    await userEvent.click(within(screen.getByTestId("reconciliation-banner")).getByRole("button", { name: "Reconcile" }));
    const dialog = await screen.findByRole("dialog", { name: "Reconcile deliveries" });
    expect(await within(dialog).findByText(/Company C — 10 × Cisco Router/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconcile" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Settle this delivery" }));
    expect(within(dialog).getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("Enter the cost of ONE unit"); // nothing is sent with a missing cost
    expect(byUrl("/reconcile")).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText("Actual cost of one unit"), "30000");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Supplier invoice 77");
    await userEvent.click(within(dialog).getByRole("button", { name: "Settle this delivery" }));
    await waitFor(() => expect(byUrl("/reconcile")).toHaveLength(1));
    expect(bodyOf(byUrl("/reconcile")[0])).toEqual({ unitCost: "30000", reason: "Supplier invoice 77" });
    await waitFor(() => expect(byUrl("/api/finance/summary").length).toBeGreaterThan(0)); // the figures are read again
  });
});

describe("the transaction history", () => {
  it("has the five columns, the four categories (and all), and a row for each kind of transaction", () => {
    mount();
    const table = screen.getByRole("region", { name: "Transactions" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Date", "Client / Description", "Transaction", "Amount", "Profit / Loss"]);
    const filters = screen.getByRole("group", { name: "Filter transactions" });
    expect(within(filters).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Investments", "Profitable sales", "Loss-making sales", "Expenses & adjustments", "Needs reconciliation"]);
    const rows = screen.getAllByTestId("history-row");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["owner_contribution", "inventory_purchase", "sale", "sale", "sale", "expense"]);
  });

  it("shows an investment signed, a purchase as 'not new capital', a profit and a loss in colour, and a pending sale as pending", () => {
    mount();
    const [contribution, purchase, profit, loss, pending, expense] = screen.getAllByTestId("history-row");
    expect(contribution.textContent).toContain("+5,000,000.00");
    expect(within(contribution).getByRole("button", { name: "Reverse" })).toBeTruthy();
    expect(purchase.textContent).toContain("Not new capital");
    expect(purchase.textContent).toContain("GR-000001 · Purchase order PO-000001");
    expect(within(purchase).queryByRole("button", { name: "Reverse" })).toBeNull();
    expect(profit.textContent).toContain("+400,000.00");
    expect(loss.textContent).toContain("-20,000.00");
    expect(within(loss).getAllByText("-20,000.00")[0].className).toContain("text-red-300");
    expect(pending.textContent).toContain("Needs cost reconciliation");
    expect(pending.textContent).toContain("Pending");
    expect(within(pending).getByRole("button", { name: "Reconcile" })).toBeTruthy();
    expect(expense.textContent).toContain("-50,000.00");
  });

  it("links each row to where it came from", () => {
    mount();
    const link = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(link("50 x Dell Latitude Laptop bought")).toBe("/goods-receipts/g1");
    expect(link("Warehouse rent")).toBe("/finance/expenses/e1");
    expect(sourceHref({ source_type: "invoice", source_id: "i9" })).toBe("/invoices/i9");
    expect(sourceHref({ source_type: "capital_record", source_id: "c1" })).toBeNull();
    expect(sourceHref({ source_type: "dispatch", source_id: null })).toBe("/delivery-lists");
  });

  it("filters by category through the portal's route and keeps the period", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Loss-making sales" }));
    await waitFor(() => expect(byUrl("/api/finance/history").at(-1)!.url).toContain("category=loss_sales"));
    expect(byUrl("/api/finance/history").at(-1)!.url).toContain("period=1m");
    expect(screen.getByRole("button", { name: "Loss-making sales", pressed: true })).toBeTruthy();
  });

  it("pages through the results", async () => {
    stubRoutes({ "/api/finance/history": () => json(200, history(ROWS.slice(0, 2), { total: 60, offset: 25 })) });
    mount({ history: history(ROWS, { total: 60 }) });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(byUrl("/api/finance/history").at(-1)!.url).toContain("offset=25"));
    expect(await screen.findByText(/Showing 26–27 of 60/)).toBeTruthy();
  });

  it("formats dates in the organization's own time zone", () => {
    expect(formatDay("2026-11-10T20:30:00+00:00", "Asia/Karachi")).toBe("11 Nov 2026"); // already the 11th in Karachi
    expect(formatDay("2026-11-10T20:30:00+00:00", "UTC")).toBe("10 Nov 2026");
    expect(signed("1000.5000")).toBe("+1,000.50");
    expect(signed("-0.5000")).toBe("-0.50");
    expect(signed("0.0000")).toBe("0.00");
  });
});

describe("Record Investment", () => {
  async function open() {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Record Investment" }));
    return screen.getByRole("dialog", { name: "Record Investment" });
  }

  it("refuses an empty or invalid amount and sends nothing", async () => {
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    expect(within(dialog).getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("Enter an amount above zero");
    await userEvent.type(within(dialog).getByLabelText("Amount"), "12.345678");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    expect(byUrl("/api/finance/investments")).toHaveLength(0);
  });

  it("records an owner contribution with its fields and ONE Idempotency-Key, then reads the figures again", async () => {
    stubRoutes({ "/api/finance/investments": () => json(201, { record: { id: "r1" } }) });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Amount"), "5000000");
    await userEvent.type(within(dialog).getByLabelText("Description"), "Seed money");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(byUrl("/api/finance/investments")).toHaveLength(1));
    const call = byUrl("/api/finance/investments")[0];
    expect(call.init.method).toBe("POST");
    expect(bodyOf(call)).toMatchObject({ kind: "contribution", entryType: "cash", amount: "5000000", currencyCode: "PKR", description: "Seed money" });
    expect(keyOf(call)).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Record Investment" })).toBeNull());
    await waitFor(() => expect(byUrl("/api/finance/summary").length).toBeGreaterThan(0));
  });

  it("cannot be submitted twice while it is saving (a double click records one)", async () => {
    let release: (r: Response) => void = () => undefined;
    stubRoutes({ "/api/finance/investments": () => new Promise<Response>((resolve) => { release = resolve; }) });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Amount"), "1000");
    const save = within(dialog).getByRole("button", { name: "Record" });
    await userEvent.dblClick(save);
    await userEvent.click(within(dialog).getByRole("button", { name: "Saving…" }));
    expect(byUrl("/api/finance/investments")).toHaveLength(1);
    release(json(201, { record: { id: "r1" } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Record Investment" })).toBeNull());
  });

  it("a retry after a failure reuses the key (so it can never be recorded twice); a refused request gets a new one", async () => {
    let mode: "error" | "refused" | "ok" = "error";
    stubRoutes({ "/api/finance/investments": () => (mode === "error" ? json(502, { error: "The request could not be completed. Please try again." }) : mode === "refused" ? json(400, { error: "Please correct the highlighted fields.", fieldErrors: { effectiveDate: "The date cannot be in the future." } }) : json(201, { record: {} })) });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("Amount"), "1000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    expect(await within(dialog).findByText("The request could not be completed. Please try again.")).toBeTruthy();
    mode = "refused";
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await within(dialog).findByText("The date cannot be in the future.");
    mode = "ok";
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(byUrl("/api/finance/investments")).toHaveLength(3));
    const [first, second, third] = byUrl("/api/finance/investments").map(keyOf);
    expect(second).toBe(first); // a server error: the same request may already have been recorded, so it is the SAME request
    expect(third).not.toBe(second); // a refusal released its key: the corrected form is a new request
  });

  it("a withdrawal and an in-kind valuation are explained and sent as such", async () => {
    stubRoutes({ "/api/finance/investments": () => json(201, { record: {} }) });
    const dialog = await open();
    await userEvent.selectOptions(within(dialog).getByLabelText("Investment type"), "withdrawal");
    await userEvent.selectOptions(within(dialog).getByLabelText("Form of the investment"), "inventory");
    expect(within(dialog).getByText(/counted ONCE, at the valuation you enter/)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Valuation"), "1000000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(byUrl("/api/finance/investments")).toHaveLength(1));
    expect(bodyOf(byUrl("/api/finance/investments")[0])).toMatchObject({ kind: "withdrawal", entryType: "inventory", amount: "1000000" });
  });
});

describe("Add Expense", () => {
  it("posts the expense straight away, in the chosen category and currency", async () => {
    stubRoutes({ "/api/finance/expenses": () => json(201, { expense: { id: "e1" } }) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Add Expense" }));
    const dialog = screen.getByRole("dialog", { name: "Add Expense" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add expense" }));
    expect(within(dialog).getAllByRole("alert").length).toBeGreaterThan(0);
    expect(byUrl("/api/finance/expenses")).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText("Amount"), "50000");
    await userEvent.type(within(dialog).getByLabelText("Description"), "Warehouse rent");
    await userEvent.type(within(dialog).getByLabelText("Paid to"), "Landlord");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add expense" }));
    await waitFor(() => expect(byUrl("/api/finance/expenses")).toHaveLength(1));
    const call = byUrl("/api/finance/expenses")[0];
    expect(bodyOf(call)).toMatchObject({ accountId: "acc-1", amount: "50000", description: "Warehouse rent", vendor: "Landlord", currencyCode: "PKR", post: true });
    expect(keyOf(call)).toBeTruthy();
  });
});

describe("the opening position", () => {
  it("previews the owner's equity exactly and records it", async () => {
    stubRoutes({ "/api/finance/opening-positions": (_url, init) => (init.method === "POST" ? json(201, { position: { id: "p1" } }) : json(200, { items: [] })) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Opening position" }));
    const dialog = screen.getByRole("dialog", { name: "Opening position" });
    await userEvent.type(within(dialog).getByLabelText("Assets"), "8000000.1");
    await userEvent.type(within(dialog).getByLabelText("Liabilities"), "3000000.3");
    expect(within(dialog).getByTestId("equity-preview").textContent).toContain("PKR 4,999,999.80"); // exact: no floating point
    await userEvent.click(within(dialog).getByRole("button", { name: "Set opening position" }));
    await waitFor(() => expect(byUrl("/api/finance/opening-positions").filter((c) => c.init.method === "POST")).toHaveLength(1));
    expect(bodyOf(byUrl("/api/finance/opening-positions").filter((c) => c.init.method === "POST")[0])).toMatchObject({ currencyCode: "PKR", assets: "8000000.1", liabilities: "3000000.3" });
  });

  it("an existing position is shown and can only be reversed, with a reason", async () => {
    const position = { id: "p1", currency_code: "PKR", effective_date: "2026-11-01", assets: "8000000.0000", liabilities: "3000000.0000", equity: "5000000.0000", status: "active", reversal_reason: null, notes: null };
    stubRoutes({ "/api/finance/opening-positions": (url, init) => (url.endsWith("/reverse") ? json(200, { position: {} }) : init.method === "POST" ? json(201, {}) : json(200, { items: [position] })) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Opening position" }));
    const dialog = screen.getByRole("dialog", { name: "Opening position" });
    expect((await within(dialog).findByTestId("active-position")).textContent).toContain("owner equity PKR 5,000,000.00");
    expect(within(dialog).queryByRole("button", { name: "Set opening position" })).toBeNull(); // one active position per currency
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse to correct it" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse it" }));
    expect(within(dialog).getAllByRole("alert")[0].textContent).toContain("at least 3 characters");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Wrong balance sheet");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse it" }));
    await waitFor(() => expect(byUrl("/api/finance/opening-positions/p1/reverse")).toHaveLength(1));
    expect(bodyOf(byUrl("/api/finance/opening-positions/p1/reverse")[0])).toEqual({ reason: "Wrong balance sheet" });
  });
});

describe("the cost of stock", () => {
  it("finds a product, takes the cost of ONE unit and records it", async () => {
    stubRoutes({
      "/api/products": () => json(200, { items: [{ id: "p1", sku: "LAP-1", name: "Dell Latitude Laptop" }], total: 1 }),
      "/api/finance/inventory-costs": (_url, init) => (init.method === "POST" ? json(201, { entry: { id: "c1" } }) : json(200, { items: [] })),
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Stock cost" }));
    const dialog = screen.getByRole("dialog", { name: "Stock cost" });
    await userEvent.type(within(dialog).getByLabelText("Product"), "lap");
    await userEvent.click(await within(dialog).findByRole("button", { name: "LAP-1 — Dell Latitude Laptop" }));
    await userEvent.type(within(dialog).getByLabelText("Quantity"), "40");
    await userEvent.type(within(dialog).getByLabelText("Cost of one unit"), "30000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record stock cost" }));
    await waitFor(() => expect(byUrl("/api/finance/inventory-costs").filter((c) => c.init.method === "POST")).toHaveLength(1));
    expect(bodyOf(byUrl("/api/finance/inventory-costs").filter((c) => c.init.method === "POST")[0])).toMatchObject({ productId: "p1", quantity: "40", unitCost: "30000", currencyCode: "PKR" });
  });

  it("will not record without a product or a cost", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Stock cost" }));
    const dialog = screen.getByRole("dialog", { name: "Stock cost" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Record stock cost" }));
    expect(within(dialog).getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("Choose a product");
    expect(byUrl("/api/finance/inventory-costs").filter((c) => c.init.method === "POST")).toHaveLength(0);
  });
});

describe("reversing a record", () => {
  it("needs a reason and says nothing is deleted", async () => {
    stubRoutes({ "/api/finance/investments/c1/reverse": () => json(201, { record: {} }) });
    mount();
    const contribution = screen.getAllByTestId("history-row")[0];
    await userEvent.click(within(contribution).getByRole("button", { name: "Reverse" }));
    const dialog = screen.getByRole("dialog", { name: "Reverse this record" });
    expect(dialog.textContent).toContain("Nothing is deleted");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse" }));
    expect(within(dialog).getAllByRole("alert")[0].textContent).toContain("at least 3 characters");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Entered twice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse" }));
    await waitFor(() => expect(byUrl("/api/finance/investments/c1/reverse")).toHaveLength(1));
    expect(bodyOf(byUrl("/api/finance/investments/c1/reverse")[0])).toEqual({ reason: "Entered twice" });
  });
});

describe("errors", () => {
  it("shows a failed reading and keeps the last good figures", async () => {
    stubRoutes({ "/api/finance/summary": () => json(503, { error: "The finance service is unavailable. Please try again shortly." }) });
    mount();
    await userEvent.click(screen.getByRole("radio", { name: "1 Year" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The finance service is unavailable");
    expect(screen.getByTestId("capital-value").textContent).toBe("PKR 5,400,000.00");
  });
});

describe("the look", () => {
  it("is built from the portal's theme tokens only: no fixed colours that would ignore the chosen background or accent", () => {
    for (const file of ["finance-view.tsx", "summary-cards.tsx", "history-panel.tsx", "finance-modals.tsx"]) {
      const source = readFileSync(join(__dirname, "..", "src", "app", "finance", file), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\b(?:bg|text|border)-(?:white|black|slate-\d+|gray-\d+|zinc-\d+|neutral-\d+|stone-\d+)\b/);
      expect(source, file).not.toMatch(/\bstyle=\{\{[^}]*(?:color|background)/);
    }
  });

  it("stays out of the Theme Customizer", () => {
    for (const file of ["finance-view.tsx", "summary-cards.tsx", "history-panel.tsx", "finance-modals.tsx"]) {
      const source = readFileSync(join(__dirname, "..", "src", "app", "finance", file), "utf8");
      expect(source, file).not.toMatch(/theme-customizer|data-ix-bg|data-ix-accent|ThemeCustomizer/);
    }
  });
});
