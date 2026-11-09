import type { Metadata } from "next";
import { cookies } from "next/headers";

import { THEME_COOKIE } from "@/lib/session";
import { decodeThemeCookie, themeAttributes, themeCss } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Impex | Super Admin Portal",
  description: "Enterprise multi-tenant microservices platform for global trade and inventory",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The administrator's colours are painted by the SERVER, from a cache cookie validated against the approved identifiers (anything else is the
  // default theme): the very first byte already has the right background and accent, so nothing flashes and nothing can mismatch on hydration.
  // The CSS for every choice is one deterministic string from lib/theme.ts; the choice is three data attributes on <html>.
  const theme = decodeThemeCookie(cookies().get(THEME_COOKIE)?.value);
  return (
    <html lang="en" {...themeAttributes(theme)}>
      <head>
        <style id="ix-theme" dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

