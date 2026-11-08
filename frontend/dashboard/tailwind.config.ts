import type { Config } from "tailwindcss";

// Colours that follow a CSS variable (a space-separated "r g b" triplet), so one class can take the accent of the section the page is in
// (Inventory powder blue, Purchasing pale butter, Sales sea-glass mint ...; see globals.css) and still support opacity modifiers.
const variable = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

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
        // The Organization Portal's palette: the dashboard's slate-teal foundation, its sea-glass tones, and three pastel accents.
        ix: {
          deep: "#172A32", slate: "#324D58", teal: "#568E8F", sea: "#86B6AA", sage: "#A6C1B2", mist: "#D8E8E3", text: "#EDF4F1", muted: "#B5CBC9",
          butter: "#E8D8A4", mint: "#96C5B8", blue: "#A7C7D8", // the three accents
          action: "#3C7173", "action-hover": "#4A8184", // the general "primary action" fill (white text: 5.4:1)
          accent: variable("--ix-accent-rgb"), "accent-soft": variable("--ix-accent-soft-rgb"), // the current section's accent
        },
        // The legacy pages are written with Tailwind's slate and indigo. They are mapped onto the palette here, ONCE, so every page inherits the
        // theme: slate becomes the blue-grey/teal ramp, and indigo becomes the (deep) action colour plus the current section's accent for links.
        slate: {
          50: "#F4F8F6", 100: "#EDF4F1", 200: "#D8E8E3", 300: "#C6D9D5", 400: "#B5CBC9", 500: "#8FA8A7", 600: "#5F7C84", 700: "#3B5762", 800: "#2A444F", 900: "#1C323B", 950: "#14262D",
        },
        indigo: {
          50: "#EDF4F1", 100: "#D8E8E3", 200: variable("--ix-accent-soft-rgb"), 300: variable("--ix-accent-rgb"), 400: variable("--ix-accent-rgb"),
          500: "#4A8184", 600: "#3C7173", 700: "#2F5C5F", 800: "#244A4D", 900: "#1C3B3E", 950: "#142D30",
        },
      },
      borderRadius: { "ix-sm": "14px", "ix-md": "18px", "ix-lg": "22px" },
    },
  },
  plugins: [],
};
export default config;
