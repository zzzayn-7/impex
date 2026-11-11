// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import SelectEnhancer, { splitClasses } from "@/components/ui/select-enhancer";
import { formatDateTime } from "@/lib/format";
import { timezoneChoices, timezoneLabel } from "@/lib/timezones";

afterEach(cleanup);

function Form({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("c2");
  return (
    <>
      <label>
        Currency
        <select className="w-full rounded-xl border px-3" value={value} onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); }}>
          {Array.from({ length: 30 }, (_, i) => <option key={i} value={`c${i}`}>{i === 7 ? "Euro" : `Option ${i}`}</option>)}
        </select>
      </label>
      <SelectEnhancer />
    </>
  );
}

describe("every dropdown is compact and searchable", () => {
  it("shows five rows at a time with a search box on top, and finds an option by typing", async () => {
    const seen: string[] = [];
    render(<Form onChange={(v) => seen.push(v)} />);
    const button = await screen.findByRole("button", { name: "Currency" });
    expect(button.textContent).toContain("Option 2");
    await userEvent.click(button);
    const list = screen.getByRole("listbox");
    expect(list.getAttribute("data-visible-rows")).toBe("5");
    expect((list as HTMLElement).style.maxHeight).toBe("200px"); // 5 rows of 40px; the rest scrolls
    const search = screen.getByRole("searchbox");
    expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the search box is above the list
    await userEvent.type(search, "eur");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Euro"]);
    await userEvent.click(within(list).getByRole("option", { name: "Euro" }));
    expect(seen).toEqual(["c7"]); // the page's own onChange ran, with the real select's value
    expect(button.textContent).toContain("Euro");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says when nothing matches, and Escape closes it", async () => {
    render(<Form />);
    await userEvent.click(await screen.findByRole("button", { name: "Currency" }));
    await userEvent.type(screen.getByRole("searchbox"), "zzzz");
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("keeps the layout classes on the wrapper and the look on the button", () => {
    expect(splitClasses("mt-1 w-full appearance-none rounded-xl border px-3 pr-8")).toEqual({ layout: "mt-1", look: "rounded-xl border px-3" });
  });

  it("leaves a select marked data-native alone", async () => {
    render(<><select data-native aria-label="Plain"><option>a</option></select><SelectEnhancer /></>);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: "Plain" })).toBeNull();
  });
});

describe("time on a 12-hour clock", () => {
  it("writes 08:01 PM, not 20:01", () => {
    expect(formatDateTime("2026-11-11T20:01:00Z", { default_currency: "USD", timezone: "UTC", date_format: "DD/MM/YYYY", number_format: "comma_dot" } as any)).toBe("11/11/2026 08:01 PM");
    expect(formatDateTime("2026-11-11T00:05:00Z", { default_currency: "USD", timezone: "UTC", date_format: "DD/MM/YYYY", number_format: "comma_dot" } as any)).toBe("11/11/2026 12:05 AM");
    expect(formatDateTime("2026-11-11T12:30:00Z", { default_currency: "USD", timezone: "UTC", date_format: "DD/MM/YYYY", number_format: "comma_dot" } as any)).toBe("11/11/2026 12:30 PM");
  });
});

describe("time zones are named country / city", () => {
  it("labels by country and city, keeps the IANA id as the value, UTC first, the saved zone always present", () => {
    expect(timezoneLabel("Asia/Karachi")).toBe("Pakistan / Karachi");
    expect(timezoneLabel("America/New_York")).toBe("United States / New York");
    expect(timezoneLabel("UTC")).toBe("UTC");
    const choices = timezoneChoices("Asia/Karachi");
    expect(choices[0]).toEqual({ value: "UTC", label: "UTC" });
    expect(choices.find((c) => c.value === "Europe/London")?.label).toBe("United Kingdom / London");
    expect(choices.some((c) => /^(Asia|Europe|America|Africa)\//.test(c.label))).toBe(false); // no continent / city labels
    const rest = choices.slice(1).map((c) => c.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
});
