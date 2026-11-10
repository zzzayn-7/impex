// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import DashboardFrame from "@/components/dashboard/frame";

// With the pointer over the sidebar the page behind never moves: the list scrolls itself, and at its ends (or anywhere else on the sidebar) the wheel does nothing.

afterEach(cleanup);

const mount = () => render(
  <DashboardFrame admin={{ id: "u", email: "o@x.y", full_name: "Olivia Owner", role: "organization-admin", organization_id: "o", is_active: true, created_at: "x" } as any} organization={{ name: "Alpha", modules: ["inventory", "sales"] } as any}>
    <p>the page</p>
  </DashboardFrame>,
);
const aside = () => document.getElementById("ix-sidebar") as HTMLElement;
const nav = () => aside().querySelector("nav") as HTMLElement;
const scrollable = (top: number, client = 400, height = 1000) => {
  for (const [key, value] of Object.entries({ scrollTop: top, clientHeight: client, scrollHeight: height })) Object.defineProperty(nav(), key, { configurable: true, value });
};
/** fireEvent returns false when the event was cancelled (preventDefault). */
const wheel = (target: Element, init: WheelEventInit) => !fireEvent.wheel(target, { cancelable: true, bubbles: true, ...init });

describe("the sidebar contains the mouse wheel", () => {
  it("is a scroll-contained panel with a scroll-contained list (CSS overscroll-behavior: contain)", () => {
    mount();
    expect(aside().className).toContain("overscroll-contain");
    expect(nav().className).toContain("overscroll-contain");
  });

  it("the list scrolls itself while it can; at the end the next wheel does NOT move the page", () => {
    mount();
    const link = nav().querySelector("a")!;
    scrollable(100);
    expect(wheel(link, { deltaY: 120 })).toBe(false); // down, room left: the list scrolls
    expect(wheel(link, { deltaY: -120 })).toBe(false); // up, room left
    scrollable(600); // exactly at the bottom (600 + 400 = 1000)
    expect(wheel(link, { deltaY: 120 })).toBe(true); // down at the end: held, the page stays
    expect(wheel(link, { deltaY: -120 })).toBe(false); // but back up still works
    scrollable(0);
    expect(wheel(link, { deltaY: -120 })).toBe(true); // up at the top: held
    expect(wheel(link, { deltaY: 120 })).toBe(false);
  });

  it("a list that fits (nothing to scroll) never passes the wheel to the page", () => {
    mount();
    scrollable(0, 400, 400);
    expect(wheel(nav().querySelector("a")!, { deltaY: 120 })).toBe(true);
    expect(wheel(nav().querySelector("a")!, { deltaY: -120 })).toBe(true);
  });

  it("the rest of the sidebar (the logo row, the gaps) holds the wheel too", () => {
    mount();
    scrollable(100);
    expect(wheel(aside().firstElementChild!, { deltaY: 120 })).toBe(true);
    expect(wheel(aside(), { deltaY: -120 })).toBe(true);
    expect(wheel(aside(), { deltaX: 80, deltaY: 0 })).toBe(true);
  });

  it("the page itself still scrolls with the pointer anywhere else, and the browser's zoom (Ctrl + wheel) is left alone", () => {
    mount();
    expect(wheel(screen.getByText("the page"), { deltaY: 120 })).toBe(false);
    expect(wheel(screen.getByRole("banner"), { deltaY: 120 })).toBe(false);
    scrollable(600);
    expect(wheel(nav().querySelector("a")!, { deltaY: 120, ctrlKey: true })).toBe(false);
  });

  it("stops holding the wheel when the sidebar goes away", () => {
    const { unmount } = mount();
    const panel = aside();
    unmount();
    expect(wheel(panel, { deltaY: 120 })).toBe(false);
  });
});
