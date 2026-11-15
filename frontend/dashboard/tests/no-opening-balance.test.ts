import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Opening Balance (stock) and Opening Position (finance) were removed from Impex: Stock In is how stock is entered, and an investment is how Capital is established.
// Records made earlier are kept and still READ (a movement recorded as an opening balance is listed as In; a position recorded earlier still counts in Capital), so a few
// files name them in a comment or a label. Nothing may offer, call or send them any more.

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(path) ? [path] : [];
});
const SRC = join(__dirname, "..", "src");
const files = walk(SRC);

describe("opening balance and opening position are gone from the portal", () => {
  it("no code calls or serves the removed endpoints", () => {
    const offenders = files.filter((f) => /\/api\/stock\/opening|stock\/opening|api\/finance\/opening-positions|\/opening-positions/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.split("src")[1])).toEqual([]);
  });

  it("no screen says Opening Balance or Opening position", () => {
    // legacy history, named in a comment or a label: the label of a movement recorded earlier; the sentence under a Capital figure built on a position recorded earlier;
    // and files that only explain, in a comment, that there is no opening balance any more
    const allowed = ["lib/stock-validation.ts", "app/finance/summary-cards.tsx", "app/api/stock/[action]/route.ts", "app/movements/movement-history.tsx", "app/stock/stock-overview.tsx", "lib/dashboard-metrics.ts", "lib/finance.ts"];
    const offenders = files.filter((f) => !allowed.some((a) => f.split(String.fromCharCode(92)).join("/").endsWith(a)) && /Opening Balance|Opening balance|Opening position|Opening Position|opening balance|opening position/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.split("src")[1])).toEqual([]);
  });

  it("the stock actions are In and Out only", async () => {
    const { STOCK_ACTIONS, MOVEMENT_TYPES } = await import("@/lib/stock-validation");
    expect([...STOCK_ACTIONS]).toEqual(["in", "out"]);
    expect([...MOVEMENT_TYPES]).toEqual(["in", "out"]);
  });
});
