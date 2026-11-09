// The Impex colour theme: ONE definition of the palettes, shared by both portals (an identical copy lives in each: they share no package, by design).
//
// A person chooses TWO independent things: a background and an accent. Nothing else about the design is customisable. There are no preset pairings: every
// background works with every accent (6 backgrounds incl. the original x 8 accents = 48 combinations). Nothing here is a per-combination theme; the
// remaining colours (glass, panels, borders, text, the legacy Tailwind ramps) are DERIVED from the two choices:
//
//   * a dark background gives frosted glass lifted from the background towards a light neutral tinted with the background's own hue;
//   * the light background (Ice) turns the neutrals around: dark ink text, translucent white glass, ink-tinted borders and tints. An accent that is too
//     pale for text on Ice keeps its hue but gets a darker shade for text and thin lines (--ix-accent-text-rgb); fills stay the chosen pastel with dark
//     text on them (--ix-on-accent-rgb). The accent is never swapped for another colour.
//
// The output is a block of CSS custom properties per choice, injected once by the root layout as <style id="ix-theme"> and switched with data attributes
// on <html> (data-ix-bg, data-ix-accent, data-ix-scheme), so every layer (including tooltips and dialogs that are rendered outside the page wrapper)
// sees the same variables. The ORIGINAL background + Pale Butter accent emit nothing: they ARE the defaults written in globals.css, so the original
// Impex look is byte-for-byte what it always was.
//
// What is stored for a person is only the two identifiers below (validated here and again by the Auth Service): never a colour value, never CSS.

export const BACKGROUNDS = [
  { id: "original", name: "Original Impex", hex: "#172A32", scheme: "dark" },
  { id: "burgundy", name: "Burgundy", hex: "#35232E", scheme: "dark" },
  { id: "ice", name: "Ice", hex: "#E7F0F4", scheme: "light" },
  { id: "graphite", name: "Graphite", hex: "#252B30", scheme: "dark" },
  { id: "deep-purple", name: "Deep Purple", hex: "#292938", scheme: "dark" },
  { id: "deep-steel-blue", name: "Deep Steel Blue", hex: "#202F3C", scheme: "dark" },
] as const;

export const ACCENTS = [
  { id: "pale-butter", name: "Pale Butter Yellow", hex: "#E8D8A4" },
  { id: "champagne-gold", name: "Champagne Gold", hex: "#D8C7A3" },
  { id: "muted-copper", name: "Muted Copper", hex: "#C58E77" },
  { id: "frost-blue", name: "Frost Blue", hex: "#AFC9D7" },
  { id: "lavender-mist", name: "Lavender Mist", hex: "#B9ADD4" },
  { id: "sage-silver", name: "Sage Silver", hex: "#AABDAF" },
  { id: "dusty-rose", name: "Dusty Rose", hex: "#CFA8B0" },
  { id: "silver-pearl", name: "Silver Pearl", hex: "#C6D0D4" },
] as const;

export type BackgroundId = (typeof BACKGROUNDS)[number]["id"];
export type AccentId = (typeof ACCENTS)[number]["id"];
export type Scheme = "dark" | "light";
export type ThemeChoice = { background: BackgroundId; accent: AccentId };

export const DEFAULT_THEME: ThemeChoice = { background: "original", accent: "pale-butter" };

const backgroundIds: readonly string[] = BACKGROUNDS.map((b) => b.id);
const accentIds: readonly string[] = ACCENTS.map((a) => a.id);
export const isBackgroundId = (value: unknown): value is BackgroundId => typeof value === "string" && backgroundIds.includes(value);
export const isAccentId = (value: unknown): value is AccentId => typeof value === "string" && accentIds.includes(value);

/** Each choice on its own, falling back to the default when it is missing or not one of the approved identifiers. */
export function themeFrom(background: unknown, accent: unknown): ThemeChoice {
  return { background: isBackgroundId(background) ? background : DEFAULT_THEME.background, accent: isAccentId(accent) ? accent : DEFAULT_THEME.accent };
}

export const backgroundOf = (id: BackgroundId) => BACKGROUNDS.find((b) => b.id === id)!;
export const accentOf = (id: AccentId) => ACCENTS.find((a) => a.id === id)!;
export const schemeOf = (id: BackgroundId): Scheme => backgroundOf(id).scheme;
export const sameTheme = (a: ThemeChoice, b: ThemeChoice) => a.background === b.background && a.accent === b.accent;

// ---- the cookie that lets the server paint the right colours on the very first byte (no flash). It is only a CACHE of the saved choice: the Auth Service
// is the record, the portal refreshes the cookie whenever it reads the user, and a cookie that is not exactly two approved identifiers is ignored.
// Each portal names its own cookie (lib/session.ts): cookies ignore ports, so the two portals on one host must never share one.
export const encodeThemeCookie = (theme: ThemeChoice) => `${theme.background}.${theme.accent}`;
export function decodeThemeCookie(value: string | undefined | null): ThemeChoice {
  const parts = (value ?? "").split(".");
  return parts.length === 2 && isBackgroundId(parts[0]) && isAccentId(parts[1]) ? { background: parts[0], accent: parts[1] } : DEFAULT_THEME;
}

// ================================================================ colour maths ================================================================
export type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

export const hexToRgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export const rgbToHex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const triplet = (c: RGB) => c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(" ");
const alpha = (c: RGB, a: number) => `rgb(${triplet(c)} / ${a})`;

/** WCAG relative luminance and contrast ratio. */
export function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => { const s = Math.max(0, Math.min(255, v)) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `a` composited over `b` at opacity `o`. */
export const over = (a: RGB, o: number, b: RGB): RGB => mix(b, a, o);

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]: [number, number, number]): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** The same hue and saturation as `c`, made darker in small steps until it reaches `min` contrast on `on`: a readable shade of the SAME colour. */
export function darkenToContrast(c: RGB, on: RGB, min: number): RGB {
  const [h, s, l] = rgbToHsl(c);
  for (let lightness = l; lightness > 0.04; lightness -= 0.005) {
    const candidate = hslToRgb([h, s, lightness]);
    if (contrast(candidate, on) >= min) return candidate;
  }
  return hslToRgb([h, s, 0.04]);
}

// ============================================================= the derived neutrals ============================================================
type Vars = Record<string, string>;

/** Neutral tones for a DARK background: the same relationships the original Impex foundation has (see the check in the tests), tinted by the background. */
function darkNeutrals(B: RGB) {
  const mist = mix(WHITE, B, 0.13), text = mix(WHITE, B, 0.075), muted = mix(WHITE, B, 0.27);
  return {
    mist, text, muted, white: WHITE, ink: B,
    slate: mix(B, mist, 0.17), panel: mix(B, mist, 0.09), inset: mix(B, BLACK, 0.33), field: mix(B, BLACK, 0.4), menuA: mix(B, mist, 0.15), menuB: mix(B, BLACK, 0.07),
    teal: mix(B, mist, 0.33), top: mix(B, mist, 0.04), bottom: mix(B, BLACK, 0.16), hl: text, shadow: mix(B, BLACK, 0.8), scroll: mix(muted, B, 0.15),
  };
}

const RAMP_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** The legacy "slate" ramp (older pages are written with slate-NNN classes): dark backgrounds put the darkest stop at the background and the lightest at white. */
function darkSlateRamp(B: RGB, n: ReturnType<typeof darkNeutrals>): Record<number, RGB> {
  return {
    50: mix(WHITE, B, 0.04), 100: n.text, 200: n.mist, 300: mix(WHITE, B, 0.2), 400: n.muted, 500: mix(B, n.mist, 0.62), 600: mix(B, n.mist, 0.38),
    700: mix(B, n.mist, 0.19), 800: mix(B, n.mist, 0.1), 900: mix(B, n.mist, 0.03), 950: mix(B, BLACK, 0.13),
  };
}

function backgroundVars(id: BackgroundId): Vars {
  const B = hexToRgb(backgroundOf(id).hex);
  return schemeOf(id) === "dark" ? darkVars(B) : lightVars(B);
}

export function darkVars(B: RGB): Vars {
  const n = darkNeutrals(B);
  const ramp = darkSlateRamp(B, n);
  const v: Vars = {
    "--ix-scheme": "dark", "--ix-color-scheme": "dark",
    "--ix-deep-rgb": triplet(B), "--ix-slate-rgb": triplet(n.slate), "--ix-teal-rgb": triplet(n.teal), "--ix-mist-rgb": triplet(n.mist), "--ix-text-rgb": triplet(n.text),
    "--ix-muted-rgb": triplet(n.muted), "--ix-white-rgb": triplet(WHITE), "--ix-on-accent-rgb": triplet(B), "--ix-shadow-rgb": triplet(n.shadow), "--ix-scroll-rgb": triplet(n.scroll), "--ix-field-rgb": triplet(n.field),
    "--ix-surface-glass": `linear-gradient(158deg, ${alpha(n.mist, 0.11)} 0%, ${alpha(n.teal, 0.07)} 38%, ${alpha(B, 0.3)} 100%), ${alpha(n.slate, 0.3)}`,
    "--ix-glass-shadow": `inset 0 1px 0 ${alpha(n.hl, 0.16)}, inset 0 -1px 0 ${alpha(B, 0.35)}, 0 14px 32px -18px ${alpha(n.shadow, 0.6)}`,
    "--ix-glass-lift-shadow": `inset 0 1px 0 ${alpha(n.hl, 0.2)}, inset 0 -1px 0 ${alpha(B, 0.35)}, 0 18px 36px -18px ${alpha(n.shadow, 0.7)}`,
    "--ix-glass-sheen": `linear-gradient(180deg, ${alpha(n.hl, 0.09)}, transparent 34%)`,
    "--ix-surface-panel": `linear-gradient(160deg, ${alpha(n.mist, 0.08)} 0%, ${alpha(B, 0.42)} 100%), ${alpha(n.panel, 0.5)}`,
    "--ix-panel-shadow": `inset 0 1px 0 ${alpha(n.hl, 0.12)}, 0 14px 32px -18px ${alpha(n.shadow, 0.6)}`,
    "--ix-surface-inset": alpha(n.inset, 0.42), "--ix-border-inset": alpha(n.mist, 0.1),
    "--ix-border": alpha(n.mist, 0.13), "--ix-border-strong": alpha(n.mist, 0.22), "--ix-hairline": alpha(n.mist, 0.12),
    "--ix-field-bg": alpha(n.field, 0.5), "--ix-field-border": alpha(n.mist, 0.16), "--ix-field-border-hover": alpha(n.mist, 0.28),
    "--ix-placeholder": alpha(n.muted, 0.6), "--ix-thead": alpha(n.field, 0.28), "--ix-ghost": alpha(n.mist, 0.04), "--ix-ghost-hover": alpha(n.mist, 0.1), "--ix-skeleton": alpha(n.mist, 0.1),
    "--ix-surface-menu": `linear-gradient(160deg, ${alpha(n.menuA, 0.97)}, ${alpha(n.menuB, 0.98)})`, "--ix-menu-border": alpha(n.mist, 0.22),
    "--ix-menu-shadow": `inset 0 1px 0 ${alpha(n.hl, 0.12)}, 0 18px 40px -14px ${alpha(n.shadow, 0.75)}`,
    "--ix-tip-bg": `linear-gradient(160deg, ${alpha(n.menuA, 0.96)}, ${alpha(n.menuB, 0.97)})`, "--ix-tip-border": alpha(n.mist, 0.2),
    "--ix-tip-shadow": `inset 0 1px 0 ${alpha(n.hl, 0.12)}, 0 14px 30px -12px ${alpha(n.shadow, 0.8)}`,
    "--ix-surface-fallback": `linear-gradient(158deg, ${alpha(n.menuA, 0.96)}, ${alpha(mix(B, n.mist, 0.1), 0.96)})`,
    "--ix-option-bg": rgbToHex(mix(B, n.mist, 0.06)), "--ix-option-checked": rgbToHex(mix(B, n.mist, 0.12)),
    "--ix-atmosphere": [
      `radial-gradient(60rem 38rem at 12% -8%, ${alpha(n.teal, 0.32)}, transparent 62%)`,
      "radial-gradient(52rem 34rem at 96% 8%, rgb(var(--ix-accent-rgb) / 0.06), transparent 60%)",
      `radial-gradient(46rem 40rem at 70% 112%, ${alpha(n.slate, 0.55)}, transparent 65%)`,
      `linear-gradient(165deg, ${rgbToHex(n.top)} 0%, ${rgbToHex(B)} 48%, ${rgbToHex(n.bottom)} 100%)`,
    ].join(", "),
    "--ix-chevron": chevron(rgbToHex(n.muted)),
  };
  for (const stop of RAMP_STOPS) { v[`--ix-slate-${stop}`] = triplet(ramp[stop]); v[`--ix-mist-${stop}`] = triplet(ramp[stop]); }
  return v;
}

/** The ink of the light scheme: very dark, with the background's own hue. */
function lightInk(P: RGB): RGB {
  const [h] = rgbToHsl(P);
  return hslToRgb([h, 0.3, 0.13]);
}

export function lightVars(P: RGB): Vars {
  const ink = lightInk(P);
  const muted = mix(ink, P, 0.3);
  const paper = mix(P, WHITE, 0.5);
  const [hue] = rgbToHsl(P);
  const glow = hslToRgb([hue, 0.55, 0.74]), glow2 = hslToRgb([hue, 0.42, 0.82]);
  const ramp = (s: number) => mix(paper, ink, s);
  const slate: Record<number, RGB> = { 50: ink, 100: mix(paper, ink, 0.97), 200: ramp(0.9), 300: ramp(0.8), 400: ramp(0.7), 500: ramp(0.62), 600: ramp(0.32), 700: ramp(0.14), 800: ramp(0.07), 900: ramp(0.03), 950: paper };
  const v: Vars = {
    "--ix-scheme": "light", "--ix-color-scheme": "light",
    "--ix-deep-rgb": triplet(paper), "--ix-slate-rgb": triplet(mix(P, ink, 0.1)), "--ix-teal-rgb": triplet(mix(P, ink, 0.45)), "--ix-mist-rgb": triplet(ink), "--ix-text-rgb": triplet(ink),
    "--ix-muted-rgb": triplet(muted), "--ix-white-rgb": triplet(ink), "--ix-on-accent-rgb": triplet(ink), "--ix-shadow-rgb": triplet(mix(ink, P, 0.15)), "--ix-scroll-rgb": triplet(mix(ink, P, 0.45)), "--ix-field-rgb": triplet(WHITE),
    "--ix-surface-glass": `linear-gradient(158deg, ${alpha(WHITE, 0.62)} 0%, ${alpha(WHITE, 0.38)} 38%, ${alpha(P, 0.35)} 100%), ${alpha(WHITE, 0.3)}`,
    "--ix-glass-shadow": `inset 0 1px 0 ${alpha(WHITE, 0.85)}, inset 0 -1px 0 ${alpha(ink, 0.07)}, 0 14px 32px -18px ${alpha(ink, 0.3)}`,
    "--ix-glass-lift-shadow": `inset 0 1px 0 ${alpha(WHITE, 0.9)}, inset 0 -1px 0 ${alpha(ink, 0.07)}, 0 18px 36px -18px ${alpha(ink, 0.34)}`,
    "--ix-glass-sheen": `linear-gradient(180deg, ${alpha(WHITE, 0.5)}, transparent 34%)`,
    "--ix-surface-panel": `linear-gradient(160deg, ${alpha(WHITE, 0.7)} 0%, ${alpha(P, 0.5)} 100%), ${alpha(WHITE, 0.4)}`,
    "--ix-panel-shadow": `inset 0 1px 0 ${alpha(WHITE, 0.8)}, 0 14px 32px -18px ${alpha(ink, 0.26)}`,
    "--ix-surface-inset": alpha(WHITE, 0.5), "--ix-border-inset": alpha(ink, 0.1),
    "--ix-border": alpha(ink, 0.13), "--ix-border-strong": alpha(ink, 0.24), "--ix-hairline": alpha(ink, 0.12),
    "--ix-field-bg": alpha(WHITE, 0.72), "--ix-field-border": alpha(ink, 0.2), "--ix-field-border-hover": alpha(ink, 0.36),
    "--ix-placeholder": alpha(ink, 0.52), "--ix-thead": alpha(ink, 0.06), "--ix-ghost": alpha(ink, 0.04), "--ix-ghost-hover": alpha(ink, 0.09), "--ix-skeleton": alpha(ink, 0.1),
    "--ix-surface-menu": `linear-gradient(160deg, ${alpha(WHITE, 0.98)}, ${alpha(mix(P, WHITE, 0.55), 0.98)})`, "--ix-menu-border": alpha(ink, 0.2),
    "--ix-menu-shadow": `inset 0 1px 0 ${alpha(WHITE, 0.9)}, 0 18px 40px -14px ${alpha(ink, 0.35)}`,
    "--ix-tip-bg": `linear-gradient(160deg, ${alpha(WHITE, 0.97)}, ${alpha(mix(P, WHITE, 0.55), 0.97)})`, "--ix-tip-border": alpha(ink, 0.2),
    "--ix-tip-shadow": `inset 0 1px 0 ${alpha(WHITE, 0.9)}, 0 14px 30px -12px ${alpha(ink, 0.35)}`,
    "--ix-surface-fallback": `linear-gradient(158deg, ${alpha(WHITE, 0.95)}, ${alpha(mix(P, WHITE, 0.5), 0.95)})`,
    "--ix-option-bg": rgbToHex(mix(P, WHITE, 0.6)), "--ix-option-checked": rgbToHex(mix(P, ink, 0.1)),
    "--ix-atmosphere": [
      `radial-gradient(60rem 38rem at 12% -8%, ${alpha(glow, 0.5)}, transparent 62%)`,
      "radial-gradient(52rem 34rem at 96% 8%, rgb(var(--ix-accent-rgb) / 0.22), transparent 60%)",
      `radial-gradient(46rem 40rem at 70% 112%, ${alpha(glow2, 0.55)}, transparent 65%)`,
      `linear-gradient(165deg, ${rgbToHex(mix(P, WHITE, 0.4))} 0%, ${rgbToHex(P)} 48%, ${rgbToHex(mix(P, ink, 0.07))} 100%)`,
    ].join(", "),
    "--ix-chevron": chevron(rgbToHex(muted)),
  };
  for (const stop of RAMP_STOPS) { v[`--ix-slate-${stop}`] = triplet(slate[stop]); v[`--ix-mist-${stop}`] = triplet(slate[stop]); }
  return { ...v, ...semanticLightVars() };
}

/** On the light background the text-oriented stops of the semantic ramps (red, amber) point at the DARK values, so a pale "text-red-300" is still readable;
 *  the rest keep their meaning (a solid 500/600 fill keeps a white label). The numbers are the stops of the dark values (--ix-red-d-N, --ix-amber-d-N). */
const SEMANTIC_LIGHT_MAP: Record<number, number> = { 50: 950, 100: 950, 200: 900, 300: 800, 400: 700, 500: 600, 600: 600, 700: 400, 800: 300, 900: 200, 950: 100 };
function semanticLightVars(): Vars {
  const v: Vars = {};
  for (const stop of RAMP_STOPS) for (const name of ["red", "amber"]) v[`--ix-${name}-${stop}`] = `var(--ix-${name}-d-${SEMANTIC_LIGHT_MAP[stop]})`;
  return v;
}

function chevron(color: string): string {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23${color.slice(1)}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E")`;
}

// ================================================================ the accent ================================================================
/** The same hue and saturation as `c`, made lighter in small steps until it reaches `min` contrast on `on`. */
export function lightenToContrast(c: RGB, on: RGB, min: number): RGB {
  for (let t = 0; t <= 1; t += 0.02) {
    const candidate = mix(c, WHITE, t);
    if (contrast(candidate, on) >= min) return candidate;
  }
  return WHITE;
}

/** The lightest surface any dark background puts text on (a menu): the reference the accent's TEXT shade must beat, so it is AA on every dark background. */
const LIGHTEST_DARK_SURFACE: RGB = BACKGROUNDS.filter((b) => b.scheme === "dark")
  .map((b) => { const B = hexToRgb(b.hex); return over(darkNeutrals(B).menuA, 0.97, B); })
  .sort((x, y) => luminance(y) - luminance(x))[0];

/** The accent as TEXT or a thin line on any dark background: the chosen colour itself, lightened only when it would otherwise be under AA (Muted Copper). */
export const darkAccentText = (A: RGB): RGB => lightenToContrast(A, LIGHTEST_DARK_SURFACE, 4.8);

/** The accent on a DARK background: the chosen colour is the fill (with dark text on it) and, lightened only if needed, the text and line colour. */
function darkAccentVars(hex: string): Vars {
  const A = hexToRgb(hex);
  const text = darkAccentText(A);
  const dark = mix(A, BLACK, 0.5);
  const ramp: Record<number, RGB> = {
    50: mix(A, WHITE, 0.8), 100: mix(A, WHITE, 0.6), 200: mix(A, WHITE, 0.45), 300: mix(A, WHITE, 0.28), 400: text, 500: mix(A, WHITE, 0.3), 600: A,
    700: mix(A, dark, 0.2), 800: mix(A, dark, 0.5), 900: mix(A, dark, 0.8), 950: mix(A, dark, 0.95),
  };
  const v: Vars = {
    "--ix-accent-rgb": triplet(A), "--ix-accent-hover-rgb": triplet(mix(A, WHITE, 0.3)), "--ix-accent-soft-rgb": triplet(mix(A, WHITE, 0.5)), "--ix-accent-text-rgb": triplet(text),
    "--ix-accent-chevron": chevron(rgbToHex(text)),
  };
  for (const stop of RAMP_STOPS) v[`--ix-accent-${stop}`] = triplet(ramp[stop]);
  return v;
}

/** The accent on a LIGHT background (Ice): the fill stays the chosen pastel (with dark text on it); text and thin lines use a darker shade of the SAME hue. */
function lightAccentVars(hex: string, bgHex: string): Vars {
  const A = hexToRgb(hex), P = hexToRgb(bgHex);
  const ink = lightInk(P);
  const text = darkenToContrast(A, P, 4.8);
  const ramp: Record<number, RGB> = {
    50: mix(A, P, 0.85), 100: mix(A, P, 0.7), 200: text, 300: text, 400: text, 500: mix(A, ink, 0.12), 600: A,
    700: mix(text, ink, 0.25), 800: mix(text, ink, 0.45), 900: mix(text, ink, 0.65), 950: mix(text, ink, 0.82),
  };
  const v: Vars = {
    "--ix-accent-rgb": triplet(A), "--ix-accent-hover-rgb": triplet(mix(A, ink, 0.1)), "--ix-accent-soft-rgb": triplet(mix(A, WHITE, 0.4)), "--ix-accent-text-rgb": triplet(text),
    "--ix-accent-chevron": chevron(rgbToHex(text)),
  };
  for (const stop of RAMP_STOPS) v[`--ix-accent-${stop}`] = triplet(ramp[stop]);
  return v;
}

const declarations = (vars: Vars) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");

/** Every variable that results from a choice, merged the way the cascade merges them (for the tests and the preview). */
export function themeVariables(theme: ThemeChoice): Vars {
  const bg = backgroundOf(theme.background), accent = accentOf(theme.accent);
  const scheme = bg.scheme;
  return { ...(theme.background === "original" ? {} : backgroundVars(theme.background)), ...(scheme === "light" ? lightAccentVars(accent.hex, bg.hex) : theme.accent === "pale-butter" ? {} : darkAccentVars(accent.hex)) };
}

/**
 * The CSS for the whole system, as a string: one rule per background, one per accent, and one per accent on the light background. 48 combinations,
 * 5 + 7 + 8 = 20 rules. Deterministic (the same string on every render), so the server and the browser can never disagree about it.
 */
export function themeCss(): string {
  const rules: string[] = [];
  for (const bg of BACKGROUNDS) if (bg.id !== "original") rules.push(`:root[data-ix-bg="${bg.id}"]{${declarations(backgroundVars(bg.id))}}`);
  for (const accent of ACCENTS) if (accent.id !== "pale-butter") rules.push(`:root[data-ix-accent="${accent.id}"]{${declarations(darkAccentVars(accent.hex))}}`);
  for (const bg of BACKGROUNDS) {
    if (bg.scheme !== "light") continue;
    for (const accent of ACCENTS) rules.push(`:root[data-ix-bg="${bg.id}"][data-ix-accent="${accent.id}"]{${declarations(lightAccentVars(accent.hex, bg.hex))}}`);
  }
  return rules.join("\n");
}

/** The attributes <html> carries for a choice. */
export function themeAttributes(theme: ThemeChoice) {
  return { "data-ix-bg": theme.background, "data-ix-accent": theme.accent, "data-ix-scheme": schemeOf(theme.background) } as const;
}

/** For tests and the preview: the colours a choice puts on the page, as plain RGB. */
export function previewColors(theme: ThemeChoice) {
  const bg = backgroundOf(theme.background), accent = accentOf(theme.accent);
  const B = hexToRgb(bg.hex), A = hexToRgb(accent.hex);
  if (bg.scheme === "dark") {
    const n = darkNeutrals(B);
    return { page: B, glass: over(n.slate, 0.3, B), text: n.text, muted: n.muted, accent: A, accentText: darkAccentText(A), onAccent: B, scheme: "dark" as Scheme };
  }
  const ink = lightInk(B);
  return { page: B, glass: over(WHITE, 0.45, B), text: ink, muted: mix(ink, B, 0.3), accent: A, accentText: darkenToContrast(A, B, 4.8), onAccent: ink, scheme: "light" as Scheme };
}
