import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orgAdmin, orgAdminB, superAdmin } from "./helpers";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined, push: () => undefined }),
}));

import FinancePage from "@/app/finance/page";
import { TENANT_SESSION_COOKIE } from "@/lib/session";

// Finance = Profit & Loss. The page reads the delivered orders of a period from the Sales Service and the saved expenses from the Finance Service and nothing else: it never asks for the
// organization's capital, investment, journal or accounts.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const delivered = (id: string, number: string, client: string, total: string | null, extra: Record<string, unknown> = {}) => ({
  id, number, client_name: client, currency_code: total ? "USD" : null, total_amount: total, completed_at: "2026-11-10T10:00:00+00:00", ...extra,
});
const expenses = (id: string, goods: string, delivery: string, others: { label: string; amount: string }[] = []) => ({ order_id: id, currency_code: "USD", goods_cost: goods, delivery_charges: delivery, other_expenses: others, updated_by_email: "a@b.c", updated_at: "2026-11-10T10:00:00+00:00" });

const fresh = () => ({
  "token-alpha": {
    delivered: [
      delivered("a1", "SO-000001", "Alpha Metals", "500000.0000"), delivered("a2", "SO-000002", "Alpha Metals", "1000.0000"), delivered("a3", "SO-000003", "Alpha Metals", "200.0000"),
      delivered("a4", "SO-000004", "Alpha Metals", null),
    ],
    expenses: [expenses("a1", "300000", "20000", [{ label: "Packing", amount: "5000" }]), expenses("a2", "900", "150")],
  },
  "token-beta": { delivered: [delivered("b1", "SO-000001", "Beta Textiles", "100.0000")], expenses: [expenses("b1", "50", "10")] },
});
let orgs: any = fresh();

let calls: { url: string; method: string }[] = [];
function stubWorld(options: { sales?: number; finance?: number; truncated?: boolean } = {}) {
  calls = [];
  const users: Record<string, any> = { "token-alpha": orgAdmin, "token-beta": orgAdminB, "token-super": superAdmin };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET" });
    const token = (headers.Authorization ?? "").replace("Bearer ", "");
    if (url.endsWith("/api/v1/auth/me")) return users[token] ? json(200, users[token]) : json(401, {});
    const org = orgs[token];
    const path = new URL(url).pathname;
    if (path === "/api/v1/sales/delivered-orders") {
      if (options.sales) return json(options.sales, { detail: "x" });
      if (!org) return json(401, {});
      return json(200, { items: org.delivered, total: options.truncated ? 5000 : org.delivered.length, truncated: Boolean(options.truncated) });
    }
    if (path === "/api/v1/finance/order-expenses") {
      if (options.finance) return json(options.finance, { detail: "x" });
      return org ? json(200, { items: org.expenses }) : json(401, {});
    }
    return json(404, {});
  }));
}
const render = async (searchParams: Record<string, string> = {}) => renderToStaticMarkup(await FinancePage({ searchParams }));
const sinceOf = () => new Date(new URL(calls.find((c) => c.url.includes("delivered-orders"))!.url).searchParams.get("since")!).getTime();

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.SALES_SERVICE_URL = "http://sales-service:8003";
  process.env.FINANCE_SERVICE_URL = "http://finance-service:8006";
  for (const key of Object.keys(jar)) delete jar[key];
  orgs = fresh();
});
afterEach(() => vi.unstubAllGlobals());

describe("Finance = Profit & Loss", () => {
  it("lists the delivered orders with their result: +x% for a profit, -x% for a loss, and the five periods", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    for (const expected of ["Profit &amp; Loss", "1 Day", "1 Week", "1 Month", "6 Months", "1 Year", "SO-000001", "SO-000002", "Alpha Metals", "+53.85%", "-4.76%", "Add expenses", "No prices"]) expect(html, expected).toContain(expected);
    expect(html).toContain('href="/finance?period=1w"');
    expect(html).toMatch(/aria-current="page"[^>]*>1 Month</); // the page opens on a month
  });

  it("shows a profit in green and a loss in red, the loss with its minus sign", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    expect(html).toMatch(/data-percent[^>]*text-ix-gain[^>]*>\+53\.85%/);
    expect(html).toMatch(/data-percent[^>]*text-red-400[^>]*>-4\.76%/);
    expect(html).toContain("+175,000.00 USD"); // the amounts are shown small beneath
    expect(html).toContain("-50.00 USD");
  });

  it("shows the portfolio of the period: sales, invested, profit and return", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const html = await render();
    expect(html).toContain("Portfolio · USD");
    expect(html).toContain("2 of 3 orders worked out"); // the order without prices is not counted
    expect(html).toContain("501,200.00 USD"); // sales of the three orders that have prices
    expect(html).toContain("326,050.00 USD"); // invested: 325,000 + 1,050
    expect(html).toContain("+174,950.00 USD");
    expect(html).toMatch(/data-return="" class="[^"]*text-ix-gain[^"]*">\+53\.66%/);
    expect(html).toContain("1 delivered order has no expenses yet");
    expect(html).toContain('href="/pnl-calculator"');
  });

  it("a period that lost money shows its return in red with a minus", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].delivered = [delivered("a2", "SO-000002", "Alpha Metals", "1000.0000")];
    const html = await render();
    expect(html).toMatch(/data-return="" class="[^"]*text-red-400[^"]*">-4\.76%/);
    expect(html).toContain(">Loss<");
  });

  it("asks only for the chosen period, and anything else is a month", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const day = 24 * 3600 * 1000;
    for (const [period, days] of [["1d", 1], ["1w", 7], ["1m", 30], ["6m", 183], ["1y", 365]] as const) {
      calls = [];
      await render({ period });
      expect(Math.abs((Date.now() - sinceOf()) / day - days), period).toBeLessThan(3); // a month is 28 to 31 days, 6 months 181 to 184, a year 365 or 366
    }
    calls = [];
    await render({ period: "banana" });
    expect(Math.abs((Date.now() - sinceOf()) / day - 30)).toBeLessThan(3);
  });

  it("never asks for the organization's whole finances", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    await render({ period: "1y" });
    const finance = calls.filter((c) => c.url.includes("/api/v1/finance/")).map((c) => new URL(c.url).pathname);
    expect(finance).toEqual(["/api/v1/finance/order-expenses"]);
    expect(calls.some((c) => /summary|history|pnl-trend|accounts|journal|capital|investments/.test(c.url))).toBe(false);
  });

  it("pages the orders, 25 to a page, the portfolio always covering all of them", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].delivered = Array.from({ length: 30 }, (_, i) => delivered(`x${i}`, `SO-${String(i + 1).padStart(6, "0")}`, "Alpha Metals", "100.0000"));
    orgs["token-alpha"].expenses = [];
    const one = await render({ page: "1" });
    const two = await render({ page: "2" });
    expect(one).toContain("Showing 1–25 of 30");
    expect(two).toContain("Showing 26–30 of 30");
    expect(one).toContain("SO-000001");
    expect(two).not.toContain("SO-000001");
    expect(two).toContain("SO-000030");
    expect(two).toContain("3,000.00 USD"); // the portfolio's sales: all 30 orders, not the page
    expect(await render({ page: "banana" })).toContain("Showing 1–25 of 30");
  });

  it("two organizations: each sees only their own orders and results", async () => {
    stubWorld();
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    const a = await render();
    jar[TENANT_SESSION_COOKIE] = "token-beta";
    const b = await render();
    expect(a).toContain("Alpha Metals");
    expect(a).not.toContain("Beta Textiles");
    expect(b).toContain("Beta Textiles");
    expect(b).toContain("+66.67%"); // 100 - 50 - 10 = 40 on 60 spent
    expect(b).not.toContain("Alpha Metals");
  });

  it("says so when nothing was delivered, and still lists the orders when the Finance Service is down (they just need their expenses)", async () => {
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    orgs["token-alpha"].delivered = [];
    stubWorld();
    expect(await render()).toContain("No delivered orders in this period.");
    expect(calls.some((c) => c.url.includes("/api/v1/finance/"))).toBe(false); // nothing to join: the Finance Service is not asked
    orgs = fresh();
    stubWorld({ finance: 503 });
    const html = await render();
    expect(html).toContain("SO-000001");
    expect(html).toContain("Add expenses");
  });

  it("says when a period has more orders than are counted", async () => {
    stubWorld({ truncated: true });
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    expect(await render()).toContain("This period has 5000 delivered orders; only the newest 4 are counted.");
  });

  it("redirects without a session and for a Super Admin, and explains the Sales module, an outage and an expired session", async () => {
    stubWorld();
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    jar[TENANT_SESSION_COOKIE] = "token-super";
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    expect(calls.some((c) => c.url.includes("delivered-orders"))).toBe(false);
    jar[TENANT_SESSION_COOKIE] = "token-alpha";
    stubWorld({ sales: 403 });
    expect(await render()).toContain("needs the Sales module");
    stubWorld({ sales: 503 });
    expect(await render()).toContain("temporarily unavailable");
    stubWorld({ sales: 401 });
    await expect(render()).rejects.toThrow("REDIRECT:/login");
  });
});
