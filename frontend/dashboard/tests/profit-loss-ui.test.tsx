// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import ProfitLossView from "@/app/finance/profit-loss-view";
import type { Portfolio, ReportRow } from "@/lib/profit-loss";

const row = (n: number, extra: Partial<ReportRow> = {}): ReportRow => ({
  id: `o${n}`, number: `SO-${String(n).padStart(6, "0")}`, client_name: "Alpha Metals", currency_code: "USD", total_amount: "1000.0000", completed_at: "2026-11-10T10:00:00+00:00",
  state: "profit", profit: "100.0000", invested: "900.0000", bps: 1111, ...extra,
});
const portfolio = (extra: Partial<Portfolio> = {}): Portfolio => ({ currency: "USD", orders: 3, sales: "3000.0000", calculated: 3, invested: "2700.0000", profit: "300.0000", bps: 1111, verdict: "profit", ...extra });
const props = { period: "1m" as const, page: 1, problem: null, rows: [row(1)], total: 1, portfolios: [portfolio()], notCalculated: 0, truncated: false, deliveredTotal: 1 };

beforeEach(() => { router.push.mockReset(); });
afterEach(cleanup);

describe("Finance = Profit & Loss", () => {
  it("has one tab per period, the chosen one current, each a link to its own address", () => {
    render(<ProfitLossView {...props} period="6m" />);
    const tabs = within(screen.getByRole("navigation", { name: "Period" }));
    expect(tabs.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href"), l.getAttribute("aria-current")])).toEqual([
      ["1 Day", "/finance?period=1d", null], ["1 Week", "/finance?period=1w", null], ["1 Month", "/finance?period=1m", null], ["6 Months", "/finance?period=6m", "page"], ["1 Year", "/finance?period=1y", null],
    ]);
  });

  it("a profit is +x% in green, a loss is -x% in red with its minus sign, an even trade 0%", () => {
    render(<ProfitLossView {...props} rows={[row(1), row(2, { state: "loss", profit: "-50.0000", invested: "1050.0000", bps: -476 }), row(3, { state: "even", profit: "0.0000", invested: "1000.0000", bps: 0 })]} total={3} />);
    const percents = Array.from(document.querySelectorAll("[data-percent]"));
    expect(percents.map((p) => p.textContent)).toEqual(["+11.11%", "-4.76%", "0%"]);
    expect(percents[0].className).toContain("text-ix-gain");
    expect(percents[1].className).toContain("text-red-400");
    expect(percents[1].className).not.toContain("gain");
    expect(screen.getByText("+100.00 USD")).toBeTruthy();
    expect(screen.getByText("-50.00 USD")).toBeTruthy();
  });

  it("an order without expenses offers Add expenses (the calculator), one without prices says so", () => {
    render(<ProfitLossView {...props} rows={[row(1, { state: "no-expenses", profit: null, invested: null, bps: null }), row(2, { state: "no-prices", total_amount: null, currency_code: null, profit: null, invested: null, bps: null })]} total={2} notCalculated={1} />);
    expect(screen.getByRole("link", { name: "Add expenses" }).getAttribute("href")).toBe("/pnl-calculator/o1");
    expect(screen.getByText("No prices")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open SO-000001" }).getAttribute("href")).toBe("/pnl-calculator/o1");
    expect(screen.getByRole("status").textContent).toContain("1 delivered order has no expenses yet");
  });

  it("shows the portfolio per currency, the return in the colour of the result", () => {
    render(<ProfitLossView {...props} portfolios={[portfolio(), portfolio({ currency: "EUR", profit: "-20.0000", bps: -400, verdict: "loss", sales: "500.0000", invested: "520.0000" })]} />);
    const usd = within(document.querySelector('[data-portfolio="USD"]') as HTMLElement);
    expect(usd.getByText("3,000.00 USD")).toBeTruthy();
    expect(usd.getByText("2,700.00 USD")).toBeTruthy();
    expect(usd.getByText("+300.00 USD")).toBeTruthy();
    expect(usd.getByText("+11.11%").className).toContain("text-ix-gain");
    expect(usd.getByText("3 of 3 orders worked out")).toBeTruthy();
    const eur = within(document.querySelector('[data-portfolio="EUR"]') as HTMLElement);
    expect(eur.getByText("Loss")).toBeTruthy();
    expect(eur.getByText("-20.00 USD".replace("USD", "EUR"))).toBeTruthy();
    expect(eur.getByText("-4%").className).toContain("text-red-400");
  });

  it("a portfolio with nothing worked out shows dashes, not zeros", () => {
    render(<ProfitLossView {...props} portfolios={[portfolio({ calculated: 0, invested: "0.0000", profit: "0.0000", bps: null, verdict: "none" })]} />);
    const card = within(document.querySelector('[data-portfolio="USD"]') as HTMLElement);
    expect(card.getAllByText("—")).toHaveLength(3);
    expect(card.getByText("0 of 3 orders worked out")).toBeTruthy();
  });

  it("pages forward and back keeping the period", async () => {
    render(<ProfitLossView {...props} period="1w" page={2} rows={[row(26)]} total={30} />);
    expect(screen.getByText("Showing 26–26 of 30")).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.push).toHaveBeenLastCalledWith("/finance?period=1w");
    cleanup();
    render(<ProfitLossView {...props} period="1w" page={1} rows={[row(1)]} total={30} />);
    await u.click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith("/finance?period=1w&page=2");
  });

  it("says plainly when nothing was delivered, and explains the Sales module and an outage", () => {
    const { unmount } = render(<ProfitLossView {...props} rows={[]} total={0} portfolios={[]} />);
    expect(screen.getByText("No delivered orders in this period.")).toBeTruthy();
    unmount();
    const second = render(<ProfitLossView {...props} problem="forbidden" rows={[]} total={0} portfolios={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("Sales module");
    second.unmount();
    render(<ProfitLossView {...props} problem="unavailable" rows={[]} total={0} portfolios={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});

import { within } from "@testing-library/react";
