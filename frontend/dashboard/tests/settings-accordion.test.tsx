// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import { Card } from "@/app/settings/settings-ui";

afterEach(() => { cleanup(); window.location.hash = ""; });

const details = (id: string) => document.querySelector<HTMLDetailsElement>(`#${id} details`)!;

describe("a settings area is a dropdown", () => {
  it("is closed to begin with, shows only its title, and opens its form downwards when the title is clicked", async () => {
    render(<Card id="company" title="Company profile" description="How your company is named."><label>Name<input /></label></Card>);
    expect(details("company").open).toBe(false);
    expect(screen.getByRole("heading", { name: "Company profile" })).toBeTruthy();
    await userEvent.click(screen.getByText("Company profile"));
    expect(details("company").open).toBe(true);
    await userEvent.click(screen.getByText("Company profile"));
    expect(details("company").open).toBe(false);
  });

  it("keeps the form mounted while closed, so half-typed values are not lost", async () => {
    render(<Card id="company" title="Company profile"><label>Name<input /></label></Card>);
    await userEvent.click(screen.getByText("Company profile"));
    await userEvent.type(screen.getByLabelText("Name"), "Alpha");
    await userEvent.click(screen.getByText("Company profile")); // close
    await userEvent.click(screen.getByText("Company profile")); // open again
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alpha");
  });

  it("opens the area named by the page address (#preferences)", () => {
    window.location.hash = "#preferences";
    render(<><Card id="company" title="Company profile">a</Card><Card id="preferences" title="Business preferences">b</Card></>);
    expect(details("company").open).toBe(false);
    expect(details("preferences").open).toBe(true);
  });

  it("each area opens on its own", async () => {
    render(<><Card id="company" title="Company profile">a</Card><Card id="branding" title="Company branding">b</Card></>);
    await userEvent.click(within(document.getElementById("branding")!).getByText("Company branding"));
    expect(details("branding").open).toBe(true);
    expect(details("company").open).toBe(false);
  });
});
