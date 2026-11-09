// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tooltip } from "@/components/ui/tooltip";

const root = join(__dirname, "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf-8");

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = () => act(() => { vi.advanceTimersByTime(600); });

describe("the shared tooltip", () => {
  it("renders nothing extra until it is asked for, and does not wrap the control in a box", () => {
    const { container } = render(<Tooltip label="Hello"><button type="button">Go</button></Tooltip>);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(container.querySelector("span.contents > button")).toBeTruthy();
  });

  it("appears on mouse hover after a short delay, in <body> (outside any clipping card), and goes away on leave", () => {
    render(<div style={{ overflow: "hidden" }}><Tooltip label="Collapse navigation"><button type="button">Go</button></Tooltip></div>);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Go" }));
    expect(screen.queryByRole("tooltip")).toBeNull(); // not instantly
    flush();
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Collapse navigation");
    expect(tip.parentElement).toBe(document.body); // a portal: never clipped by a card's overflow or hidden behind a backdrop-filter
    expect(tip.className).toContain("ix-tip");
    fireEvent.mouseLeave(screen.getByRole("button", { name: "Go" }));
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("never takes pointer events, so it cannot block a click", () => {
    expect(css).toMatch(/\.ix-tip\s*\{[^}]*pointer-events:\s*none/);
  });

  it("opens for keyboard focus and closes on blur and on Escape", () => {
    render(<Tooltip label="Keyboard hint"><button type="button">Go</button></Tooltip>);
    const button = screen.getByRole("button", { name: "Go" });
    // jsdom has no :focus-visible; a keyboard focus reports it, a mouse focus does not
    const original = button.matches.bind(button);
    button.matches = (selector: string) => (selector === ":focus-visible" ? true : original(selector));
    fireEvent.focus(button);
    flush();
    expect(screen.getByRole("tooltip").textContent).toBe("Keyboard hint");
    fireEvent.keyDown(window, { key: "Escape" });
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(button);
    flush();
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(button);
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is not opened by a mouse-driven focus (a click), only by keyboard focus", () => {
    render(<Tooltip label="Hint"><button type="button">Go</button></Tooltip>);
    const button = screen.getByRole("button", { name: "Go" });
    button.matches = () => false; // :focus-visible is false after a click
    fireEvent.focus(button);
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("can describe its control for assistive technology, and only when asked", () => {
    render(<Tooltip label="More detail" describe><button type="button">Go</button></Tooltip>);
    const button = screen.getByRole("button", { name: "Go" });
    fireEvent.mouseEnter(button);
    flush();
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.mouseLeave(button);
    flush();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("renders just the control when there is nothing to say or it is disabled (no redundant tooltip)", () => {
    const { rerender } = render(<Tooltip label="" ><button type="button">Go</button></Tooltip>);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Go" }));
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
    rerender(<Tooltip label="Shown" disabled><button type="button">Go</button></Tooltip>);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Go" }));
    flush();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is themed: dark slate glass, a thin border, 11px corners and a pale-yellow indicator", () => {
    const rule = /\.ix-tip\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain("border: 1px solid");
    expect(rule).toContain("border-radius: 11px");
    expect(rule).toContain("backdrop-filter");
    expect(css).toMatch(/\.ix-tip::before\s*\{[^}]*var\(--ix-accent-text\)/); // the accent (a readable shade of it on the light background)
    expect(rule).toContain("var(--ix-tip-bg)");
    expect(rule).toContain("color: var(--ix-text)");
    expect(css).toMatch(/\.ix-tip\s*\{[^}]*z-index:\s*70/);
  });
});

describe("selects (every one, in both portals)", () => {
  const selectRule = /\.ix-dash select:not\(\[multiple\]\):not\(\[size\]\)\s*\{([^}]*)\}/.exec(css)![1];

  it("draw their own chevron instead of the browser's, centred vertically inside the box", () => {
    expect(selectRule).toContain("appearance: none");
    expect(selectRule).toContain("background-image: var(--ix-chevron)");
    expect(css).toMatch(/--ix-chevron:\s*url\("data:image\/svg\+xml/); // the default chevron; every theme draws its own colour
    expect(selectRule).toContain("background-repeat: no-repeat");
    expect(selectRule).toMatch(/background-position:\s*right [\d.]+rem center/);
  });

  it("reserve room on the right for the arrow and cut a long label with an ellipsis instead of running under it", () => {
    expect(selectRule).toMatch(/padding-right:\s*2\.75rem\s*!important/); // wins over any px-* utility
    expect(selectRule).toContain("text-overflow: ellipsis");
    expect(selectRule).toContain("white-space: nowrap");
    expect(selectRule).toMatch(/min-height:\s*2\.5rem/);
  });

  it("turn the arrow pale yellow on hover and focus, and keep the option list dark", () => {
    expect(css).toMatch(/select:not\(\[multiple\]\):not\(\[size\]\):hover:not\(:disabled\),[\s\S]*?:focus\s*\{[^}]*var\(--ix-accent-chevron\)/);
    expect(css).toMatch(/--ix-accent-chevron:\s*url\([^)]*%23E8D8A4/); // pale yellow by default
    expect(css).toMatch(/\.ix-dash select option[^{]*\{[^}]*background-color:\s*var\(--ix-option-bg\)/);
    expect(css).toMatch(/--ix-option-bg:\s*#1a3039/); // the option list stays dark on the dark backgrounds
    expect(css).toMatch(/--ix-color-scheme:\s*dark/);
    expect(css).toContain("color-scheme: var(--ix-color-scheme)");
  });
});

describe("buttons, fields and focus use the accent", () => {
  it("a primary button is dark slate text on pale yellow", () => {
    expect(css).toMatch(/bg-indigo-600[\s\S]*?\{[^}]*background-color:\s*var\(--ix-accent\)[^}]*color:\s*var\(--ix-on-accent\)/);
  });
  it("focus rings and focused fields follow the accent", () => {
    expect(css).toMatch(/\.ix-dash :focus-visible\s*\{\s*outline:\s*2px solid var\(--ix-focus\)/);
    expect(css).toMatch(/--ix-focus:\s*rgb\(var\(--ix-accent-text-rgb\)/); // the readable shade of the accent
    expect(css).toMatch(/:focus\s*\{[^}]*box-shadow:\s*var\(--ix-ring\)/);
  });
  it("app-rendered menus are dark glass with a pale-yellow hover", () => {
    expect(css).toMatch(/\.ix-menu\s*\{[^}]*border-radius:\s*16px/);
    expect(css).toMatch(/\.ix-menu-item:hover[^{]*\{[^}]*rgb\(var\(--ix-accent-text-rgb\) \/ 0\.12\)/);
    expect(css).toMatch(/\.ix-menu\s*\{[^}]*background:\s*var\(--ix-surface-menu\)/);
  });
  it("reduced motion switches the tooltip's motion off", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ix-tip\s*\{\s*transition:\s*none/);
  });
});
