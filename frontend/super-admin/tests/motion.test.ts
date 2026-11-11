import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Nothing on the portal just appears, and the page is a fixed size (the same motion block as the Organization Portal: globals.css is identical in both).
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf-8");

describe("motion and a static page", () => {
  const css = read("src/app/globals.css");

  it("reserves the scrollbar's space, eases pages / dropdowns / dialogs / notices in, and switches it all off for reduced motion", () => {
    expect(css).toMatch(/html\s*\{\s*scrollbar-gutter:\s*stable;\s*overflow-x:\s*clip;\s*\}/);
    for (const rule of [/\.ix-page > \*\s*\{\s*animation: ix-page-in/, /\.ix-pop\s*\{\s*animation: ix-pop-in/, /\[role="alert"\], \[role="status"\]\s*\{\s*animation: ix-notice-in/, /dialog\[open\]\s*\{\s*opacity: 1; scale: 1;/, /@starting-style/]) expect(css).toMatch(rule);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ix-page > \*[^}]*animation: none !important/);
  });

  it("every page's main element uses it, from the login screen on", () => {
    for (const file of ["src/components/portal-shell.tsx", "src/app/login/page.tsx", "src/app/activate/page.tsx"]) expect(read(file), file).toMatch(/<main[^>]*\bix-page\b/);
  });

  it("there is no Clear filters button anywhere: every filter dropdown has an 'All' option instead", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : []; });
    for (const file of walk(join(__dirname, "..", "src"))) expect(readFileSync(file, "utf-8"), file).not.toContain("Clear filters");
  });
});
