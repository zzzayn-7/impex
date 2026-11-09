import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACCENTS, BACKGROUNDS, DEFAULT_THEME, contrast, darkVars, decodeThemeCookie, encodeThemeCookie, hexToRgb, isAccentId, isBackgroundId, lightVars, previewColors,
  schemeOf, themeAttributes, themeCss, themeFrom, themeVariables, type AccentId, type BackgroundId,
} from "@/lib/theme";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const PAIRS: Array<[BackgroundId, AccentId]> = BACKGROUNDS.flatMap((b) => ACCENTS.map((a) => [b.id, a.id] as [BackgroundId, AccentId]));

describe("the palettes", () => {
  it("offers exactly the five new backgrounds (and the original Impex one so a reset is a real, selectable state)", () => {
    expect(BACKGROUNDS.map((b) => [b.name, b.hex])).toEqual([
      ["Original Impex", "#172A32"], ["Burgundy", "#35232E"], ["Ice", "#E7F0F4"], ["Graphite", "#252B30"], ["Deep Purple", "#292938"], ["Deep Steel Blue", "#202F3C"],
    ]);
    expect(BACKGROUNDS.filter((b) => b.id !== "original")).toHaveLength(5);
  });

  it("offers exactly the eight accents", () => {
    expect(ACCENTS.map((a) => [a.name, a.hex])).toEqual([
      ["Pale Butter Yellow", "#E8D8A4"], ["Champagne Gold", "#D8C7A3"], ["Muted Copper", "#C58E77"], ["Frost Blue", "#AFC9D7"],
      ["Lavender Mist", "#B9ADD4"], ["Sage Silver", "#AABDAF"], ["Dusty Rose", "#CFA8B0"], ["Silver Pearl", "#C6D0D4"],
    ]);
  });

  it("the default is the original dark slate-teal with Pale Butter Yellow, and only Ice is a light background", () => {
    expect(DEFAULT_THEME).toEqual({ background: "original", accent: "pale-butter" });
    expect(BACKGROUNDS.filter((b) => b.scheme === "light").map((b) => b.id)).toEqual(["ice"]);
    expect(schemeOf("ice")).toBe("light");
    expect(schemeOf("burgundy")).toBe("dark");
  });

  it("every background pairs with every accent: 5 x 8 = 40 new pairings (48 with the original background)", () => {
    expect(PAIRS).toHaveLength(48);
    expect(PAIRS.filter(([b]) => b !== "original")).toHaveLength(40);
  });
});

describe("only approved identifiers are ever accepted (no arbitrary CSS)", () => {
  it("validates each identifier exactly", () => {
    expect(isBackgroundId("ice")).toBe(true);
    expect(isBackgroundId("#E7F0F4")).toBe(false);
    expect(isBackgroundId("ice; color:red")).toBe(false);
    expect(isBackgroundId("ICE")).toBe(false);
    expect(isBackgroundId(7)).toBe(false);
    expect(isAccentId("muted-copper")).toBe(true);
    expect(isAccentId("url(javascript:alert(1))")).toBe(false);
  });

  it("falls back to the default for each choice on its own", () => {
    expect(themeFrom("ice", "frost-blue")).toEqual({ background: "ice", accent: "frost-blue" });
    expect(themeFrom("ice", "nope")).toEqual({ background: "ice", accent: "pale-butter" });
    expect(themeFrom("<script>", "frost-blue")).toEqual({ background: "original", accent: "frost-blue" });
    expect(themeFrom(null, undefined)).toEqual(DEFAULT_THEME);
  });

  it("reads the cookie back only when it is exactly two approved identifiers", () => {
    for (const [b, a] of PAIRS) expect(decodeThemeCookie(encodeThemeCookie({ background: b, accent: a }))).toEqual({ background: b, accent: a });
    for (const bad of [undefined, "", "ice", "ice.", ".frost-blue", "ice.frost-blue.extra", "ice.frost-blue;x", "red.blue", "ice.\"><script>", "x".repeat(500)]) expect(decodeThemeCookie(bad), String(bad)).toEqual(DEFAULT_THEME);
  });

  it("the attributes on <html> are the identifiers and the scheme, nothing else", () => {
    expect(themeAttributes({ background: "ice", accent: "dusty-rose" })).toEqual({ "data-ix-bg": "ice", "data-ix-accent": "dusty-rose", "data-ix-scheme": "light" });
  });
});

describe("the generated CSS", () => {
  const css = themeCss();

  it("is one deterministic string (the server and the browser can never disagree) with a rule per choice, not per combination", () => {
    expect(themeCss()).toBe(css);
    const rules = css.split("\n");
    expect(rules).toHaveLength(5 + 7 + 8); // 5 backgrounds + 7 accents + the 8 accents on the light background
    expect(rules.filter((r) => /^:root\[data-ix-bg="[a-z-]+"\]\{/.test(r))).toHaveLength(5);
    expect(rules.filter((r) => /^:root\[data-ix-accent="[a-z-]+"\]\{/.test(r))).toHaveLength(7);
    expect(rules.filter((r) => /^:root\[data-ix-bg="ice"\]\[data-ix-accent="[a-z-]+"\]\{/.test(r))).toHaveLength(8);
  });

  it("contains custom properties and nothing a browser could run: no urls but the select chevron, no scripts, no imports, no expressions", () => {
    expect(css).not.toMatch(/<\/?style|<script|javascript:|@import|expression\(|behavior:|-moz-binding/i);
    expect(css.replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, "")).not.toMatch(/url\(/i);
    for (const rule of css.split("\n")) expect(rule, rule.slice(0, 40)).toMatch(/^:root(\[data-ix-[a-z]+="[a-z-]+"\])+\{(--ix-[a-z0-9-]+:[^;{}]+;?)+\}$/);
  });

  it("the original background with Pale Butter Yellow emits nothing: it IS the default written in globals.css", () => {
    expect(themeVariables(DEFAULT_THEME)).toEqual({});
    expect(css).not.toContain('data-ix-bg="original"');
    expect(css.split("\n").some((rule) => rule.startsWith(':root[data-ix-accent="pale-butter"]'))).toBe(false); // on dark backgrounds it is the default accent (on Ice it has its own darker-text rule)
  });

  it("every variable it sets has a default in globals.css, so nothing is ever undefined", () => {
    const globals = read("src/app/globals.css");
    const rootStart = globals.indexOf(":root {\n  --ix-scheme");
    const rootBlock = globals.slice(rootStart, globals.indexOf("\n}\n", rootStart));
    const names = new Set<string>();
    for (const [b, a] of PAIRS) for (const key of Object.keys(themeVariables({ background: b, accent: a }))) names.add(key);
    expect(names.size).toBeGreaterThan(60);
    for (const name of names) expect(rootBlock, name).toContain(`${name}:`);
  });
});

describe("the dark backgrounds are derived the way the original foundation was built", () => {
  const parse = (value: string) => value.split(" ").map(Number);
  const near = (actual: string, expected: number[], tolerance: number, label: string) => {
    parse(actual).forEach((v, i) => expect(Math.abs(v - expected[i]), `${label} channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
  };

  it("applied to the original #172A32 it reproduces the original neutrals (so Deep Steel Blue and the others feel like the same Impex)", () => {
    const v = darkVars(hexToRgb("#172A32"));
    // (the original is hand-tuned and a little bluer than a neutral derivation: the relationships and lightness steps match, not every channel)
    near(v["--ix-slate-rgb"], [50, 77, 88], 12, "slate");
    near(v["--ix-mist-rgb"], [216, 232, 227], 10, "mist");
    near(v["--ix-text-rgb"], [237, 244, 241], 6, "text");
    near(v["--ix-muted-rgb"], [181, 203, 201], 12, "muted");
    near(v["--ix-slate-800"], [42, 68, 79], 12, "slate-800");
    near(v["--ix-slate-950"], [20, 38, 45], 6, "slate-950");
    near(v["--ix-slate-600"], [95, 124, 132], 14, "slate-600");
    near(v["--ix-field-rgb"], [11, 25, 31], 8, "field");
    expect(v["--ix-deep-rgb"]).toBe("23 42 50");
  });
});

describe("every one of the 48 pairings is legible (WCAG AA) and keeps the chosen accent recognisable", () => {
  const AA = 4.5;
  it.each(PAIRS)("%s + %s", (background, accent) => {
    const theme = { background, accent };
    const c = previewColors(theme);
    expect(contrast(c.text, c.page), "text on the page").toBeGreaterThanOrEqual(7);
    expect(contrast(c.muted, c.page), "muted text on the page").toBeGreaterThanOrEqual(AA);
    expect(contrast(c.muted, c.glass), "muted text on a glass card").toBeGreaterThanOrEqual(AA);
    expect(contrast(c.accentText, c.page), "the accent as text / thin line on the page").toBeGreaterThanOrEqual(AA);
    expect(contrast(c.accentText, c.glass), "the accent as text on a glass card").toBeGreaterThanOrEqual(AA);
    expect(contrast(c.onAccent, c.accent), "the label on a filled accent button").toBeGreaterThanOrEqual(AA);
    // never silently another colour: the fill is exactly the chosen one, and on Ice the text shade has the same hue
    expect(c.accent).toEqual(hexToRgb(ACCENTS.find((a) => a.id === accent)!.hex));
  });

  it("on the light background a pale accent keeps its hue but gets a darker shade for text; on dark backgrounds the accent itself is the text", () => {
    const hue = (c: number[]) => { const [r, g, b] = c.map((v) => v / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return 0; const d = max - min; const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
    for (const accent of ACCENTS) {
      const dark = previewColors({ background: "burgundy", accent: accent.id });
      // on dark backgrounds the chosen colour is the text colour; one that would be just under AA as text is lightened a little, but never changes hue
      expect(dark.accentText.reduce((s, v) => s + v, 0), `${accent.id} is never darkened`).toBeGreaterThanOrEqual(dark.accent.reduce((s, v) => s + v, 0));
      expect(Math.abs(hue(dark.accentText) - hue(dark.accent)), `${accent.id} keeps its hue on dark`).toBeLessThan(6);
      expect(contrast(dark.accentText, dark.page), accent.id).toBeGreaterThanOrEqual(4.5);
      const light = previewColors({ background: "ice", accent: accent.id });
      const [lumA, lumT] = [light.accent, light.accentText].map((c) => c.reduce((s, v) => s + v, 0));
      expect(lumT, `${accent.id} text shade is darker`).toBeLessThan(lumA);
      const sat = Math.max(...light.accent) - Math.min(...light.accent);
      if (sat > 25) expect(Math.abs(hue(light.accentText) - hue(light.accent)), `${accent.id} keeps its hue`).toBeLessThan(14);
    }
  });

  it("Ice adapts the neutrals: dark ink for text and borders, light glass, and the legacy 'white' becomes the ink", () => {
    const v = lightVars(hexToRgb("#E7F0F4"));
    const ink = v["--ix-text-rgb"].split(" ").map(Number);
    expect(ink.reduce((s, x) => s + x, 0)).toBeLessThan(180); // very dark
    expect(v["--ix-white-rgb"]).toBe(v["--ix-text-rgb"]); // text-white of an older page is readable on Ice
    expect(v["--ix-mist-rgb"]).toBe(v["--ix-text-rgb"]); // tints and borders are ink-coloured, not light
    expect(v["--ix-color-scheme"]).toBe("light");
    expect(v["--ix-surface-glass"]).toMatch(/rgb\(255 255 255 \/ 0\.\d+\)/); // translucent white: frosted glass, never an opaque card
    expect(v["--ix-surface-glass"]).not.toMatch(/ \/ 1\)/);
    expect(v["--ix-atmosphere"]).toContain("radial-gradient"); // the background keeps its gradients
    const dark = darkVars(hexToRgb("#35232E"));
    expect(dark["--ix-color-scheme"]).toBe("dark");
    expect(dark["--ix-text-rgb"].split(" ").map(Number).reduce((s, x) => s + x, 0)).toBeGreaterThan(600);
  });

  it("the semantic red and amber stay readable on Ice (their pale text stops point at dark values) and are not remapped on dark backgrounds", () => {
    const v = lightVars(hexToRgb("#E7F0F4"));
    expect(v["--ix-red-300"]).toBe("var(--ix-red-d-800)");
    expect(v["--ix-amber-100"]).toBe("var(--ix-amber-d-950)");
    expect(darkVars(hexToRgb("#35232E"))["--ix-red-300"]).toBeUndefined();
  });
});

describe("the theme lives in one place", () => {
  it("tailwind.config.ts holds no colour literals: every colour is a variable (so the runtime theme reaches every class)", () => {
    const config = read("tailwind.config.ts");
    expect(config).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(config).toContain("--ix-accent-text-rgb");
    expect(config).toContain("--ix-white-rgb");
  });

  it("globals.css keeps no stray colour literal of the old palette outside the :root defaults (and print rules)", () => {
    const globals = read("src/app/globals.css");
    const start = globals.indexOf(":root {\n  --ix-scheme");
    const end = globals.indexOf("\n}\n", start);
    const outside = (globals.slice(0, start) + globals.slice(end)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media print\s*\{[\s\S]*?\n\}/g, "");
    for (const literal of [/rgba\(216, ?232, ?227/, /rgba\(237, ?244, ?241/, /rgba\(23, ?42, ?50/, /rgba\(50, ?77, ?88/, /rgba\(36, ?60, ?70/, /rgba\(11, ?25, ?31/, /rgba\(14, ?29, ?35/, /rgba\(48, ?76, ?86/, /rgba\(21, ?40, ?48/, /rgba\(232, ?216, ?164/, /rgba\(181, ?203, ?201/, /rgba\(86, ?142, ?143/, /#e8d8a4/i, /#edf4f1/i, /#1a3039/i, /#2c4651/i, /#172a32/i])
      expect(outside, String(literal)).not.toMatch(literal);
    expect(read("src/app/globals.css")).toContain("var(--ix-surface-glass)");
  });

  it("the approved identifiers match the Auth Service's list (when the whole repository is checked out)", () => {
    const python = join(root, "..", "..", "services", "auth-service", "app", "theme.py");
    if (!existsSync(python)) return;
    const source = readFileSync(python, "utf-8");
    const list = (name: string) => [...source.matchAll(new RegExp(`${name}[^=]*=\\s*\\(([^)]*)\\)`, "g"))][0][1].match(/"([a-z-]+)"/g)!.map((s) => s.replace(/"/g, ""));
    expect(list("BACKGROUND_IDS")).toEqual(BACKGROUNDS.map((b) => b.id));
    expect(list("ACCENT_IDS")).toEqual(ACCENTS.map((a) => a.id));
  });
});
