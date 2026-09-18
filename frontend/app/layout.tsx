import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Arbitrage Platform",
  description: "Amazon to eBay sell-first arbitrage operations",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
