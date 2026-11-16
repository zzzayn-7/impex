// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import OrderCheckout from "@/app/sales-orders/new/order-checkout";
import type { OrderRow } from "@/lib/order-form";

// The price box on the Order Checkout step is a finished field, not a bare input: it has its own border, padding and one control height (the same as every other text box of the portal),
// the currency sits inside it, and a wrong price turns the whole box red (the portal's global field rule sets the border colour, so the red has to be forced).

const row = (n: number, unitPrice: string): OrderRow => ({ productId: `p${n}`, sku: `SKU-${n}`, name: `Product ${n}`, unit: "pcs", fractions: false, quantity: "10", onHand: "100", reserved: "0", available: "100", min: "0", unitPrice });
const draw = (rows: OrderRow[]) => render(<OrderCheckout clientName="Company A" clientId="c1" currency="USD" rows={rows} onPrice={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} busy={false} />);
const box = (n: number) => document.getElementById(`price-p${n}`) as HTMLInputElement;

afterEach(cleanup);

describe("Order Checkout > the price box", () => {
  it("is a real field: bordered, padded, rounded, right-aligned in the money font, with the currency inside it", () => {
    draw([row(1, "1250.5")]);
    const classes = box(1).className.split(/\s+/);
    for (const needed of ["border", "rounded-xl", "py-2.5", "pr-3", "pl-14", "text-right", "font-mono", "w-full", "outline-none"]) expect(classes, needed).toContain(needed);
    const currency = box(1).previousElementSibling as HTMLElement;
    expect(currency.textContent).toBe("USD");
    expect(currency.className).toContain("absolute"); // inside the box, at the left, not a separate piece of text beside it
    expect(box(1).parentElement!.className).toContain("relative");
    expect(box(1).className).not.toContain("!border-red"); // nothing wrong with it
  });

  it("a wrong price turns the whole box red and says why beneath it; a right one is not red", () => {
    draw([row(1, "12,5"), row(2, "300")]);
    expect(box(1).className).toContain("!border-red-300/70");
    expect(box(1).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/number/i);
    expect(box(2).className).not.toContain("red");
    expect(box(2).getAttribute("aria-invalid")).toBeNull();
  });

  it("an empty price is not an error until the box has been left, and has a placeholder", () => {
    draw([row(1, "")]);
    expect(box(1).placeholder).toBe("0.00");
    expect(box(1).className).not.toContain("red");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("every cell of a row is as tall as the box and centred on it, so a row reads on one line", () => {
    draw([row(1, "300")]);
    expect(screen.getByTestId("qty-SKU-1").className).toContain("min-h-10");
    expect(screen.getByTestId("line-SKU-1").className).toContain("items-center");
    expect(screen.getByTestId("line-SKU-1").className).toContain("whitespace-nowrap");
  });

  it("on a phone the box is thumb-sized and its label is left-aligned", () => {
    draw([row(1, "300")]);
    expect(box(1).className).toContain("max-sm:min-h-12");
    expect(box(1).closest("td")!.className).toContain("max-sm:!text-left");
  });
});
