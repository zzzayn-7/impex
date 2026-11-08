import type { Config } from "tailwindcss";

// The Impex portals have ONE decorative accent: Pale Butter Yellow #E8D8A4, on a dark slate-teal foundation. Everything colourful in the older
// pages (indigo links and buttons, emerald "good" badges, sky/violet/teal chips) is mapped onto that palette here, ONCE, so every page inherits
// the theme without its class strings being rewritten. Only semantic colours stay: red (errors, destructive actions) and amber (warnings).
// This file is kept identical in frontend/dashboard and frontend/super-admin (the two portals share no package, by design).
const variable = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

// The accent ramp. 300/400 are text on dark glass, 500 is the hover fill, 600 the resting fill (dark slate text goes on it, see globals.css).
const butter = {
  50: "#FBF8EB", 100: "#F6EFD2", 200: "#F1E7BB", 300: "#EDDFAE", 400: "#E8D8A4",
  500: "#F0E4B8", 600: "#E8D8A4", 700: "#CDBE88", 800: "#A89B6C", 900: "#6E6646", 950: "#3D3A2A",
};
// Neutral, slate-grey tints for everything that used to be a second or third accent colour (sky, violet, teal).
const mist = {
  50: "#F4F8F6", 100: "#EDF4F1", 200: "#D8E8E3", 300: "#C6D9D5", 400: "#B5CBC9",
  500: "#8FA8A7", 600: "#52707A", 700: "#46636D", 800: "#324D58", 900: "#243C46", 950: "#172A32",
};

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
          deep: "#172A32", slate: "#324D58", teal: "#568E8F", mist: "#D8E8E3", text: "#EDF4F1", muted: "#B5CBC9",
          butter: "#E8D8A4", "butter-hover": "#F0E4B8", // the accent and its hover state
          accent: variable("--ix-accent-rgb"), "accent-soft": variable("--ix-accent-soft-rgb"), // the same accent, as a translucent-capable variable
        },
        // The legacy pages are written with Tailwind's slate, indigo, emerald, sky, violet, teal and amber; they are mapped here.
        slate: {
          50: "#F4F8F6", 100: "#EDF4F1", 200: "#D8E8E3", 300: "#C6D9D5", 400: "#B5CBC9", 500: "#8FA8A7", 600: "#5F7C84", 700: "#3B5762", 800: "#2A444F", 900: "#1C323B", 950: "#14262D",
        },
        indigo: butter,
        emerald: butter,
        sky: mist,
        violet: mist,
        teal: mist,
        // Warnings stay semantic, but warmer and softer than the accent so the two never read as the same thing.
        amber: {
          50: "#FFF7EA", 100: "#FCE9C8", 200: "#F6D6A0", 300: "#EEBD78", 400: "#E5A455",
          500: "#D98C3A", 600: "#BF7228", 700: "#9A5A22", 800: "#79461E", 900: "#5C371B", 950: "#331D0D",
        },
      },
      borderRadius: { "ix-sm": "14px", "ix-md": "18px", "ix-lg": "22px", "ix-xl": "24px", "ix-field": "13px", "ix-tip": "11px" },
    },
  },
  plugins: [],
};
export default config;
