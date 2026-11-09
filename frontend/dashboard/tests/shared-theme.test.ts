import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// globals.css and tailwind.config.ts are the SHARED theme: the Super Admin Portal keeps an identical copy (its test checks that). Styling that belongs
// only to this portal's own components lives in a stylesheet next to the component, so the shared files never drift apart.
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");

describe("the shared theme stays shared", () => {
  const globals = read("src/app/globals.css");

  it("globals.css holds no styling that belongs to one component of this portal", () => {
    expect(globals).not.toContain(".ix-qty");
  });

  it("the quantity selector brings its own stylesheet, and that file only uses tokens the shared theme defines", () => {
    expect(read("src/components/ui/quantity-input.tsx")).toContain('import "./quantity-input.css"');
    const own = read("src/components/ui/quantity-input.css");
    expect(own).toContain(".ix-dash .ix-qty");
    const used = Array.from(new Set(Array.from(own.matchAll(/var\((--ix-[a-z0-9-]+)/g), (m) => m[1])));
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) expect(globals, `${token} must be defined in globals.css`).toMatch(new RegExp(`${token}\\s*:`));
  });

  it("the selector keeps the page's own background (no fill)", () => {
    const own = read("src/components/ui/quantity-input.css");
    expect(own).toMatch(/\.ix-qty \{[^}]*background: transparent/);
    expect(own).toMatch(/\.ix-qty-step \{[^}]*background: transparent/);
  });
});
