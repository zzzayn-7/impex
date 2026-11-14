// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm";
import { Modal } from "@/components/ui/modal";

// Pop-up forms on a phone. Safari on an iPhone counts the area behind its address bar and toolbars in `vh`, so a pop-up sized in vh is taller than what is visible and its
// close button or its buttons cannot be reached. Every pop-up is sized to the VISIBLE screen instead (lib/visual-viewport.ts keeps --ix-vv-h / --ix-vv-top current).

afterEach(() => { cleanup(); document.documentElement.removeAttribute("style"); });

const noViewportUnits = (className: string) => expect(className).not.toMatch(/\d\s?vh\]|\d\s?vh\b/);

describe("pop-ups are sized to the visible screen", () => {
  it("a Modal is centred in the visible area and never taller than it, with no vh height", () => {
    render(<Modal title="Edit" onClose={() => {}}>body</Modal>);
    const cls = screen.getByRole("dialog", { hidden: true }).className;
    expect(cls).toContain("top-[calc(var(--ix-vv-top,0px)+var(--ix-vv-h,100dvh)/2)]");
    expect(cls).toContain("max-h-[calc(var(--ix-vv-h,100dvh)-1.5rem)]");
    expect(cls).toContain("max-sm:w-[calc(100vw-1rem)]"); // always inside the width of the screen
    noViewportUnits(cls);
  });

  it("while a Modal is open the page publishes the visible height, and takes it back when it closes", () => {
    (window as any).visualViewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 40, scale: 1 });
    try {
      const { unmount } = render(<Modal title="Edit" onClose={() => {}}>body</Modal>);
      expect(document.documentElement.style.getPropertyValue("--ix-vv-h")).toBe("600px");
      expect(document.documentElement.style.getPropertyValue("--ix-vv-top")).toBe("40px");
      unmount();
      expect(document.documentElement.style.getPropertyValue("--ix-vv-h")).toBe("");
    } finally {
      delete (window as any).visualViewport;
    }
  });

  it("the confirmation dialog is sized the same way and scrolls instead of being cut off", () => {
    render(<ConfirmDialog open title="Delete?" message="Sure?" confirmLabel="Delete" onResolve={() => {}} />);
    const cls = screen.getByRole("dialog", { hidden: true }).className;
    expect(cls).toContain("max-h-[calc(var(--ix-vv-h,100dvh)-1.5rem)]");
    expect(cls).toContain("overflow-y-auto");
    noViewportUnits(cls);
  });
});
