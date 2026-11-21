// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import OrderList from "@/app/pnl-calculator/order-list";
import PnlForm from "@/app/pnl-calculator/[orderId]/pnl-form";

const user = () => userEvent.setup();
const now = "2026-11-07T10:00:00+00:00";
const ORDER = "d0000000-0000-4000-8000-000000000001";
const order = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  id, number, client: { id: "c1", name: "Alpha Metals", is_active: true }, status: "active", created_at: now, total_amount: "500000.0000", currency_code: "USD", prices_recorded: true, ...extra,
}) as any;
const page = (items: any[]) => ({ ok: true as const, items, total: items.length, limit: 25, offset: 0 });
const saved = (id: string, extra: Record<string, unknown> = {}) => ({ order_id: id, currency_code: "USD", goods_cost: "300000.0000", delivery_charges: "20000.0000", other_expenses: [{ label: "Packing", amount: "5000.0000" }], updated_by_email: "a@b.c", updated_at: now, ...extra }) as any;
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PNL Calculator > the orders", () => {
  const filters = { q: "", page: 1 };

  it("each order opens its own calculator, and its result says Profit or Loss with the amount", () => {
    render(<OrderList list={page([order("o1", "SO-000001"), order("o2", "SO-000002", { total_amount: "1000.0000" }), order("o3", "SO-000003", { total_amount: "300.0000" })])} filters={filters}
      expenses={[saved("o1"), saved("o2", { goods_cost: "900", delivery_charges: "150", other_expenses: [] }), saved("o3", { goods_cost: "280", delivery_charges: "20", other_expenses: [] })]} />);
    expect(screen.getByRole("link", { name: "Edit expenses of SO-000001" }).getAttribute("href")).toBe("/pnl-calculator/o1"); // a worked-out order can be edited (Actions column)
    expect(screen.queryByRole("link", { name: "Calculate SO-000001" })).toBeNull(); // and has no Calculate button
    expect(screen.getByText("SO-000001").closest("a")).toBeNull(); // the order number is plain text, not the way in
    expect(screen.getByText("Profit 175,000.00 USD")).toBeTruthy();
    expect(screen.getByText("Loss 50.00 USD")).toBeTruthy();
    expect(screen.getByText("No profit, no loss")).toBeTruthy();
  });

  it("an order with nothing saved has a Calculate button that opens its expense form; one without prices says No prices; expenses in another currency are not used", () => {
    render(<OrderList list={page([order("o1", "SO-000001"), order("o2", "SO-000002", { prices_recorded: false, total_amount: null, currency_code: null }), order("o3", "SO-000003")])} filters={filters}
      expenses={[saved("o3", { currency_code: "EUR" })]} />);
    expect(screen.queryByText("Not calculated")).toBeNull();
    const buttons = screen.getAllByRole("link", { name: /^Calculate SO/ });
    expect(buttons.map((b) => [b.textContent, b.getAttribute("href")])).toEqual([["Calculate", "/pnl-calculator/o1"], ["Calculate", "/pnl-calculator/o3"]]);
    expect(buttons[0].className).not.toMatch(/bg-indigo|bg-ix-butter/); // transparent, like the portal's other secondary buttons
    expect(buttons[0].className).toContain("bg-ix-mist/5");
    expect(screen.getByText("No prices")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Calculate SO-000002" })).toBeNull(); // an order without prices cannot be worked out
  });

  it("searching goes through the address, with only the search text", async () => {
    render(<OrderList list={page([order("o1", "SO-000001")])} filters={filters} expenses={[]} />);
    await user().type(screen.getByLabelText("Search"), "so-1{enter}");
    expect(router.push).toHaveBeenLastCalledWith("/pnl-calculator?q=so-1");
  });

  it("pages forward and back keeping the search, and shows the empty states and an outage", async () => {
    const list = { ok: true as const, items: [order("o1", "SO-000001")], total: 60, limit: 25, offset: 25 };
    const { unmount } = render(<OrderList list={list} filters={{ q: "so", page: 2 }} expenses={[]} />);
    expect(screen.getByText("Showing 26–26 of 60")).toBeTruthy();
    await user().click(screen.getByRole("button", { name: "Next" }));
    expect(router.push).toHaveBeenLastCalledWith("/pnl-calculator?q=so&page=3");
    await user().click(screen.getByRole("button", { name: "Previous" }));
    expect(router.push).toHaveBeenLastCalledWith("/pnl-calculator?q=so");
    unmount();
    const second = render(<OrderList list={page([])} filters={filters} expenses={[]} />);
    expect(screen.getByText("No orders yet.")).toBeTruthy();
    second.unmount();
    const third = render(<OrderList list={page([])} filters={{ q: "zzz", page: 1 }} expenses={[]} />);
    expect(screen.getByText("No orders found.")).toBeTruthy();
    third.unmount();
    render(<OrderList list={{ ok: false, reason: "unavailable" } as any} filters={filters} expenses={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});

describe("PNL Calculator > the Actions column", () => {
  const filters = { q: "", page: 1 };
  const draw = (expenses: any[]) => render(<OrderList list={page([order("o1", "SO-000001"), order("o2", "SO-000002")])} filters={filters} expenses={expenses} />);

  it("has an Actions column with Edit (the expense form) and Delete on every order that has prices", () => {
    draw([saved("o1")]);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit expenses of SO-000001" }).getAttribute("href")).toBe("/pnl-calculator/o1");
    expect(screen.getByRole("link", { name: "Edit expenses of SO-000002" }).getAttribute("href")).toBe("/pnl-calculator/o2"); // an order not calculated yet can be edited (opened) too
  });

  it("Delete is only available once something is saved, asks first, and removes only the saved expenses", async () => {
    draw([saved("o1")]);
    expect((screen.getByRole("button", { name: "Delete expenses of SO-000002" }) as HTMLButtonElement).disabled).toBe(true); // nothing to delete
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => { calls.push({ url: String(url), method: init.method }); return jsonResponse(200, { deleted: true }); }));
    const confirmAsk = vi.spyOn(window, "confirm").mockReturnValue(false);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Delete expenses of SO-000001" }));
    expect(calls).toHaveLength(0); // said no: nothing is deleted
    confirmAsk.mockReturnValue(true);
    await u.click(screen.getByRole("button", { name: "Delete expenses of SO-000001" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: "/api/finance/order-expenses/o1", method: "DELETE" }]);
    confirmAsk.mockRestore();
  });

  it("says why when the delete is refused, and goes to the login page when the session ended", async () => {
    draw([saved("o1")]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "There are no saved expenses for this order." })));
    await user().click(screen.getByRole("button", { name: "Delete expenses of SO-000001" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no saved expenses");
    expect(router.refresh).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "x" })));
    await user().click(screen.getByRole("button", { name: "Delete expenses of SO-000001" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    vi.restoreAllMocks();
  });
});

describe("PNL Calculator > one order", () => {
  const detail = order(ORDER, "SO-000001") as any;
  const suggestedOk = { value: "300000.0000", complete: true, missing: 0 };
  const verdict = () => document.querySelector("[data-verdict]")!.textContent;
  const amount = () => document.querySelector("[data-amount]")?.textContent;

  it("shows the selling price (the order's own total) and fills the cost of goods from the products' cost prices", () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    expect(document.querySelector("[data-selling]")!.textContent).toBe("500,000.00 USD");
    expect((screen.getByLabelText("Cost of goods") as HTMLInputElement).value).toBe("300000");
    expect((screen.getByLabelText("Delivery charges") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/From your products/)).toBeTruthy();
    expect(verdict()).toBe("Profit");
    expect(amount()).toBe("200,000.00 USD");
  });

  it("asks for the cost when it cannot be worked out, and starts with an empty box", () => {
    render(<PnlForm order={detail} saved={null} suggested={{ value: "100.0000", complete: false, missing: 2 }} />);
    expect((screen.getByLabelText("Cost of goods") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/2 products have no cost price in USD/)).toBeTruthy();
  });

  it("the result follows every keystroke: delivery charges and other expenses are subtracted from the selling price", async () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    await u.type(screen.getByLabelText("Delivery charges"), "20000");
    expect(amount()).toBe("180,000.00 USD");
    await u.click(screen.getByRole("button", { name: "Add expense" }));
    await u.type(screen.getByLabelText("Expense name"), "Packing");
    await u.type(screen.getByLabelText("Expense amount"), "5000.5");
    expect(amount()).toBe("174,999.50 USD");
    const result = document.querySelector("[data-result]")!;
    for (const text of ["Selling price", "500,000.00 USD", "Cost of goods", "Delivery charges", "Packing", "− 5,000.50 USD"]) expect(result.textContent, text).toContain(text);
  });

  it("says Loss and how much when the trade loses money, and No profit, no loss when it breaks even", async () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    const goods = screen.getByLabelText("Cost of goods");
    await u.clear(goods);
    await u.type(goods, "520000");
    expect(verdict()).toBe("Loss");
    expect(amount()).toBe("20,000.00 USD");
    expect(document.querySelector("[data-result]")!.getAttribute("data-result")).toBe("loss");
    await u.clear(goods);
    await u.type(goods, "500000");
    expect(verdict()).toBe("No profit, no loss");
    expect(amount()).toBeUndefined();
  });

  it("an order can be saved with NO expense at all: every box blank is zero, the result is the whole selling price", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any = {}) => { calls.push(JSON.parse(init.body)); return jsonResponse(200, { expenses: saved(ORDER, { goods_cost: "0.0000", delivery_charges: "0.0000", other_expenses: [] }) }); }));
    render(<PnlForm order={detail} saved={null} suggested={{ value: "0.0000", complete: false, missing: 1 }} />);
    expect((screen.getByLabelText("Cost of goods") as HTMLInputElement).value).toBe("");
    expect(verdict()).toBe("Profit");
    expect(amount()).toBe("500,000.00 USD");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user().click(save);
    expect((await screen.findByRole("status")).textContent).toBe("Saved");
    expect(calls).toEqual([{ goodsCost: "", deliveryCharges: "", otherExpenses: [] }]);
  });

  it("an empty extra-expense row (no name, no amount) is dropped and does not stop the save", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any = {}) => { calls.push(JSON.parse(init.body)); return jsonResponse(200, { expenses: saved(ORDER) }); }));
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    await user().click(screen.getByRole("button", { name: "Add expense" }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    await user().click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(calls[0].otherExpenses).toEqual([]);
  });

  it("a mistyped amount says so, shows no result and cannot be saved", async () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    await u.type(screen.getByLabelText("Delivery charges"), "12,5");
    expect(screen.getByText(/Enter each amount as a number/)).toBeTruthy();
    expect(document.querySelector("[data-verdict]")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an amount without a name cannot be saved, and removing the row clears it", async () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Add expense" }));
    await u.type(screen.getByLabelText("Expense amount"), "10");
    expect(screen.getByText("Give every expense a name.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await u.click(screen.getByRole("button", { name: "Remove expense" }));
    expect(screen.queryByLabelText("Expense amount")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("at most twenty other expenses can be added", async () => {
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    for (let i = 0; i < 20; i++) await u.click(screen.getByRole("button", { name: "Add expense" }));
    expect(screen.getAllByLabelText("Expense name")).toHaveLength(20);
    expect(screen.queryByRole("button", { name: "Add expense" })).toBeNull();
  });

  it("opens with what was saved, not with the suggestion", () => {
    render(<PnlForm order={detail} saved={saved(ORDER, { goods_cost: "310000.5000", delivery_charges: "0.0000" })} suggested={suggestedOk} />);
    expect((screen.getByLabelText("Cost of goods") as HTMLInputElement).value).toBe("310000.5");
    expect((screen.getByLabelText("Delivery charges") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Expense name") as HTMLInputElement).value).toBe("Packing");
    expect((screen.getByLabelText("Expense amount") as HTMLInputElement).value).toBe("5000");
    expect(screen.queryByText(/From your products/)).toBeNull();
    expect(amount()).toBe("184,999.50 USD");
  });

  it("Save sends only the typed amounts (the order is named in the address), says Saved and refreshes the list's data", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => { calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return jsonResponse(200, { expenses: saved(ORDER) }); }));
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const u = user();
    await u.type(screen.getByLabelText("Delivery charges"), "20000");
    await u.click(screen.getByRole("button", { name: "Add expense" }));
    await u.type(screen.getByLabelText("Expense name"), "Packing");
    await u.type(screen.getByLabelText("Expense amount"), "5000");
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("status")).textContent).toBe("Saved");
    expect(calls).toEqual([{ url: `/api/finance/order-expenses/${ORDER}`, method: "PUT", body: { goodsCost: "300000", deliveryCharges: "20000", otherExpenses: [{ label: "Packing", amount: "5000" }] } }]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("editing after saving takes the Saved message away, a refusal is shown in words, and an ended session goes to login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: "Enter the delivery charges as an amount (at most 4 decimals)." })));
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    await user().click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("delivery charges");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { expenses: saved(ORDER) })));
    await user().click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    fireEvent.change(screen.getByLabelText("Delivery charges"), { target: { value: "1" } });
    expect(screen.queryByRole("status")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "x" })));
    await user().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("a double click saves once", async () => {
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PnlForm order={detail} saved={null} suggested={suggestedOk} />);
    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(within(button.parentElement!).getByRole("button").textContent).toBe("Saving…");
    finish(jsonResponse(200, { expenses: saved(ORDER) }));
    await screen.findByRole("status");
  });
});
