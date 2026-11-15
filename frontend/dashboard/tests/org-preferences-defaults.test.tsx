// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import { ClockProvider } from "@/components/clock";
import AddStockPanel from "@/components/product/add-stock-panel";
import ProductForm from "@/components/product/product-form";
import ExpenseForm from "@/app/finance/expenses/expense-form";
import { todayIn } from "@/lib/format";

// Once an organization has chosen its time zone and its currency, every form that asks for a date or a currency starts with them: nobody types them again.

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("today in the organization's time zone", () => {
  it("is the local date, not the UTC date", () => {
    const now = new Date("2026-11-14T20:00:00Z"); // 14 Nov 20:00 in London, already 15 Nov in Auckland, still 14 Nov 12:00 in Los Angeles
    expect(todayIn("UTC", now)).toBe("2026-11-14");
    expect(todayIn("Pacific/Auckland", now)).toBe("2026-11-15");
    expect(todayIn("Asia/Karachi", now)).toBe("2026-11-15"); // 01:00 on the 15th
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-11-14");
    expect(todayIn("Not/AZone", now)).toBe("2026-11-14"); // an unknown zone falls back to UTC, never throws
  });
});

describe("the product form starts in the organization's currency", () => {
  const noop = () => {};
  const currency = () => (screen.getByLabelText("Currency") as HTMLInputElement).value;

  it("a new product (Stock > Add Stock) uses the currency chosen in setup or Settings, not USD", () => {
    render(<ClockProvider timeZone="Asia/Karachi" currency="PKR"><ProductForm onDone={noop} onCancel={noop} /></ClockProvider>);
    expect(currency()).toBe("PKR");
    expect((screen.getByLabelText("Currency") as HTMLInputElement).placeholder).toBe("PKR");
  });

  it("the Add Stock panel too", () => {
    render(<ClockProvider timeZone="UTC" currency="AED"><AddStockPanel onClose={noop} onDone={noop} /></ClockProvider>);
    expect(currency()).toBe("AED");
  });

  it("an order's own currency (a product added while buying) still wins, and an unconfigured portal falls back to USD", () => {
    const { unmount } = render(<ClockProvider timeZone="UTC" currency="PKR"><ProductForm onDone={noop} onCancel={noop} defaults={{ currencyCode: "EUR" }} /></ClockProvider>);
    expect(currency()).toBe("EUR");
    unmount();
    render(<ProductForm onDone={noop} onCancel={noop} />);
    expect(currency()).toBe("USD");
  });
});

describe("date boxes start at today in the organization's zone", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-14T20:00:00Z")); });

  it("the expense form", () => {
    const { container, unmount } = render(<ClockProvider timeZone="Pacific/Auckland" currency="NZD"><ExpenseForm categories={[]} defaultCurrency="NZD" /></ClockProvider>);
    expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe("2026-11-15");
    unmount();
    const utc = render(<ClockProvider timeZone="UTC" currency="NZD"><ExpenseForm categories={[]} defaultCurrency="NZD" /></ClockProvider>);
    expect((utc.container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe("2026-11-14");
  });
});
