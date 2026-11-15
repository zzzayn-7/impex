import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Edit, Archive (Deactivate, Retire), Restore (Reactivate) and Delete (Remove, Discard) are ICONS with a tooltip everywhere in the portal (components/ui/icon-action.tsx),
// never a button or link whose text is the word. This fails when a text-only one is added again.

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith(".tsx") ? [path] : [];
});

describe("row and toolbar actions are icons", () => {
  it("no button or link in the portal is just the word Edit, Archive, Restore, Delete, Deactivate, Reactivate, Retire or Remove", () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, "..", "src"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/>\s*(Edit|Archive|Restore|Delete|Deactivate|Reactivate|Retire|Remove)\s*<\/(button|Link)>/.test(line)) offenders.push(`${file.split("src")[1]}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the Clients page keeps no Delivery lists or Invoices shortcut in a client's actions", () => {
    const source = readFileSync(join(__dirname, "..", "src", "app", "clients", "client-manager.tsx"), "utf8");
    expect(source).not.toMatch(/>\s*Delivery lists\s*<\/Link>/);
    expect(source).not.toMatch(/>\s*Invoices\s*<\/Link>/);
  });
});
