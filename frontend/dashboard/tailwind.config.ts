import type { Config } from "tailwindcss";

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
        // The Organization Dashboard's calm blue-grey / sea-glass palette (used only by components/dashboard/*).
        ix: { deep: "#172A32", slate: "#324D58", teal: "#568E8F", sea: "#86B6AA", sage: "#A6C1B2", mist: "#D8E8E3", text: "#EDF4F1", muted: "#B5CBC9" },
      },
    },
  },
  plugins: [],
};
export default config;
