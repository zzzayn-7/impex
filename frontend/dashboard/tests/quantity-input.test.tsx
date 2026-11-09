// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QuantityInput from "@/components/ui/quantity-input";
import { decrease, increase, isZero } from "@/lib/quantity";

afterEach(cleanup);

describe("quantity arithmetic (exact decimal strings, never JavaScript numbers)", () => {
  it("starts from zero and adds ten", () => {
    expect(increase("")).toBe("10");
    expect(increase("0")).toBe("10");
    expect(increase("10")).toBe("20");
    expect(increase("95")).toBe("105");
  });

  it("keeps decimals exact", () => {
    expect(increase("2.5")).toBe("12.5");
    expect(increase("0.1")).toBe("10.1");
    expect(increase("1234567890123.4567")).toBe("1234567890133.4567");
    expect(decrease("12.5")).toBe("2.5");
    expect(decrease("10.25")).toBe("0.25");
    expect(increase("0.30")).toBe("10.3");
  });

  it("never goes below zero", () => {
    expect(decrease("25")).toBe("15");
    expect(decrease("10")).toBe("0");
    expect(decrease("5")).toBe("0");
    expect(decrease("")).toBe("0");
    expect(decrease("0.5")).toBe("0");
  });

  it("treats text and negative numbers as zero instead of guessing", () => {
    expect(increase("abc")).toBe("10");
    expect(increase("-5")).toBe("10");
    expect(increase("1,5")).toBe("10");
    expect(decrease("abc")).toBe("0");
    expect(isZero("")).toBe(true);
    expect(isZero("0.000")).toBe(true);
    expect(isZero("abc")).toBe(true);
    expect(isZero("0.0001")).toBe(false);
  });

  it("supports another step", () => {
    expect(increase("3", "5")).toBe("8");
    expect(decrease("3", "5")).toBe("0");
    expect(increase("1", "0.5")).toBe("1.5");
  });
});

function Harness({ initial = "", onKey, disabled }: { initial?: string; onKey?: (e: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return <QuantityInput aria-label="Quantity of Water" value={value} onChange={setValue} disabled={disabled} onKeyDown={(e) => onKey?.(e.key)} />;
}

describe("the quantity selector", () => {
  it("is [ - ] number [ + ]: starts at zero, plus adds 10, minus removes 10 down to zero", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByLabelText("Quantity of Water") as HTMLInputElement;
    expect(box.placeholder).toBe("0");
    const [minus, plus] = [screen.getByRole("button", { name: "Decrease quantity of Water" }) as HTMLButtonElement, screen.getByRole("button", { name: "Increase quantity of Water" })];
    expect(minus.disabled).toBe(true);
    await user.click(plus);
    await user.click(plus);
    expect(box.value).toBe("20");
    expect(minus.disabled).toBe(false);
    await user.click(minus);
    await user.click(minus);
    expect(box.value).toBe("0");
    expect(minus.disabled).toBe(true);
  });

  it("the number is a text box: click it and type any quantity, then keep stepping from there", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByLabelText("Quantity of Water") as HTMLInputElement;
    await user.click(box);
    await user.type(box, "37");
    expect(box.value).toBe("37");
    await user.click(screen.getByRole("button", { name: "Increase quantity of Water" }));
    expect(box.value).toBe("47");
  });

  it("the arrow keys step too, and the caller's own key handling still runs", async () => {
    const user = userEvent.setup();
    const keys = vi.fn();
    render(<Harness onKey={keys} />);
    const box = screen.getByLabelText("Quantity of Water") as HTMLInputElement;
    await user.click(box);
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowDown}");
    expect(box.value).toBe("10");
    expect(keys.mock.calls.map((c) => c[0])).toEqual(["ArrowUp", "ArrowUp", "ArrowDown"]);
  });

  it("has no fill of its own and a disabled one cannot be changed", async () => {
    const user = userEvent.setup();
    render(<Harness initial="5" disabled />);
    const box = screen.getByLabelText("Quantity of Water") as HTMLInputElement;
    expect(box.closest(".ix-qty")!.className).not.toMatch(/\bbg-/);
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Increase quantity of Water" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Increase quantity of Water" }));
    expect(box.value).toBe("5");
  });

  it("a label beside the selector names the number box (and only it), so a click on the label focuses the number", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <label htmlFor="q">Quantity to bill</label>
        <QuantityInput id="q" value="" onChange={() => {}} />
      </div>,
    );
    const box = screen.getByLabelText("Quantity to bill");
    expect(box.tagName).toBe("INPUT");
    await user.click(screen.getByText("Quantity to bill"));
    expect(document.activeElement).toBe(box);
  });
});
