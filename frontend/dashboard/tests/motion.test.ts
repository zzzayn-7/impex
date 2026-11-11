import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Nothing on the portal just appears, and the page is a fixed size. The CSS block is identical in both portals (the Super Admin portal's tests check its own pages); the pages use it.
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf-8");

describe("motion and a static page", () => {
  const css = read("src/app/globals.css");

  it("reserves the scrollbar's space and never lets anything widen the page", () => {
    expect(css).toMatch(/html\s*\{\s*scrollbar-gutter:\s*stable;\s*overflow-x:\s*clip;\s*\}/);
    expect(css).toMatch(/body\s*\{\s*overflow-x:\s*clip;\s*\}/);
  });

  it("pages, dropdowns, dialogs and notices ease in; hover and focus fade; reduced motion switches it all off", () => {
    for (const rule of [/\.ix-page > \*\s*\{\s*animation: ix-page-in/, /\.ix-pop\s*\{\s*animation: ix-pop-in/, /\.ix-dialog-in\s*\{/, /\[role="alert"\], \[role="status"\]\s*\{\s*animation: ix-notice-in/,
      /dialog\[open\]\s*\{\s*opacity: 1; scale: 1;/, /@starting-style/, /transition-duration: 180ms/]) expect(css).toMatch(rule);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ix-page > \*[^}]*animation: none !important/);
    expect(css).not.toMatch(/\.ix-page > \*[^{]*\{[^}]*\btransform:/); // never `transform`: a component's own transform must not be overridden
  });

  it("every page's main element uses it, from the login screen on", () => {
    for (const file of ["src/components/dashboard/frame.tsx", "src/app/login/page.tsx", "src/app/setup/layout.tsx"]) expect(read(file), file).toMatch(/<main[^>]*\bix-page\b/);
  });

  it("a dropdown list pops in", () => {
    expect(read("src/components/ui/select-enhancer.tsx")).toContain("ix-pop absolute");
  });

  it("there is no Clear filters button anywhere: every filter dropdown has an 'All' option instead", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : []; });
    for (const file of walk(join(__dirname, "..", "src"))) expect(readFileSync(file, "utf-8"), file).not.toContain("Clear filters");
  });
});
