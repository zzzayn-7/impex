import type { Metadata } from "next";
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
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

