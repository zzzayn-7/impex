// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { Card } from "@/app/settings/settings-ui";

afterEach(() => { cleanup(); window.location.hash = ""; });

const body = (id: string) => document.getElementById(`${id}-body`)!;
const toggle = (title: string) => screen.getByRole("button", { name: title });

describe("a settings area is a dropdown", () => {
  it("is closed to begin with, shows only its title, and slides its form open downwards when the title is clicked", async () => {
    render(<Card id="company" title="Company profile" description="How your company is named."><label>Name<input /></label></Card>);
    expect(toggle("Company profile").getAttribute("aria-expanded")).toBe("false");
    expect(body("company").getAttribute("data-open")).toBe("false");
    expect(body("company").hasAttribute("inert")).toBe(true); // closed: out of reach of the keyboard and screen readers
    expect(body("company").className).toContain("grid-rows-[0fr]"); // collapsed ...
    expect(body("company").className).toContain("transition-[grid-template-rows"); // ... and it animates between the two heights
    expect(screen.getByRole("heading", { name: "Company profile" })).toBeTruthy();
    await userEvent.click(toggle("Company profile"));
    expect(toggle("Company profile").getAttribute("aria-expanded")).toBe("true");
    expect(body("company").getAttribute("data-open")).toBe("true");
    expect(body("company").hasAttribute("inert")).toBe(false);
    expect(body("company").className).toContain("grid-rows-[1fr]");
    await userEvent.click(toggle("Company profile"));
    expect(body("company").getAttribute("data-open")).toBe("false");
  });

  it("keeps the form mounted while closed, so half-typed values are not lost", async () => {
    render(<Card id="company" title="Company profile"><label>Name<input /></label></Card>);
    await userEvent.click(toggle("Company profile"));
    await userEvent.type(screen.getByLabelText("Name"), "Alpha");
    await userEvent.click(toggle("Company profile")); // close
    await userEvent.click(toggle("Company profile")); // open again
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alpha");
  });

  it("opens the area named by the page address (#preferences)", () => {
    window.location.hash = "#preferences";
    render(<><Card id="company" title="Company profile">a</Card><Card id="preferences" title="Business preferences">b</Card></>);
    expect(body("company").getAttribute("data-open")).toBe("false");
    expect(body("preferences").getAttribute("data-open")).toBe("true");
  });

  it("each area opens on its own", async () => {
    render(<><Card id="company" title="Company profile">a</Card><Card id="branding" title="Company branding">b</Card></>);
    await userEvent.click(within(document.getElementById("branding")!).getByRole("button", { name: "Company branding" }));
    expect(body("branding").getAttribute("data-open")).toBe("true");
    expect(body("company").getAttribute("data-open")).toBe("false");
  });
});
