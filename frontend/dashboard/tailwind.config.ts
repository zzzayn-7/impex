import type { Config } from "tailwindcss";

// The Impex portals have ONE decorative accent at a time, on a foundation the administrator chooses (see src/lib/theme.ts). Every colour below is a
// CSS variable, so the whole interface follows the selected background and accent at runtime: the defaults are written in globals.css (the original
// Impex dark slate-teal with Pale Butter Yellow), and a choice overrides them through data attributes on <html>. The class strings of the older pages
// (slate, indigo, emerald, sky, violet, teal, white) are NOT rewritten: they are mapped onto the variables here, ONCE.
// Only semantic colours stay: red (errors, destructive actions) and amber (warnings); their stops are variables too, so they stay readable on the light
// background. This file is kept identical in frontend/dashboard and frontend/super-admin (the two portals share no package, by design).
const variable = (name: string) => `rgb(var(${name}) / <alpha-value>)`;
const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const ramp = (prefix: string) => Object.fromEntries(STOPS.map((stop) => [stop, variable(`--ix-${prefix}-${stop}`)]));

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // The foundation (deep, slate, teal, text, muted ...) plus the single accent.
        ix: {
          deep: variable("--ix-deep-rgb"), slate: variable("--ix-slate-rgb"), teal: variable("--ix-teal-rgb"), mist: variable("--ix-mist-rgb"),
          text: variable("--ix-text-rgb"), muted: variable("--ix-muted-rgb"),
          butter: variable("--ix-accent-rgb"), "butter-hover": variable("--ix-accent-hover-rgb"), // the accent as a FILL, and its hover state
          "on-accent": variable("--ix-on-accent-rgb"), // the text that goes on an accent fill
          "accent-text": variable("--ix-accent-text-rgb"), // the accent as TEXT or a thin line: on the light background a darker shade of the same hue
          accent: variable("--ix-accent-text-rgb"), "accent-soft": variable("--ix-accent-soft-rgb"), // focus rings and tints
        },
        // The legacy pages are written with Tailwind's slate, indigo, emerald, sky, violet, teal and white; they are mapped here.
        slate: ramp("slate"),
        indigo: ramp("accent"),
        emerald: ramp("accent"),
        sky: ramp("mist"),
        violet: ramp("mist"),
        teal: ramp("mist"),
        white: variable("--ix-white-rgb"), // white on the dark backgrounds, the dark ink on the light one (it is the "strong text" colour of older pages)
        // Semantic colours: red for errors and destructive actions, amber for warnings (warmer and softer than the accent so the two never read as the same thing).
        red: ramp("red"),
        amber: ramp("amber"),
      },
      borderRadius: { "ix-sm": "14px", "ix-md": "18px", "ix-lg": "22px", "ix-xl": "24px", "ix-field": "13px", "ix-tip": "11px" },
    },
  },
  plugins: [],
};
export default config;
