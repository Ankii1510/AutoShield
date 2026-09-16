import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "AutoShield — Security Operations Console",
  description:
    "Autonomous emergency response for smart contracts. GenLayer scores the evidence; a deterministic on-chain rule decides the response.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--color-ground)] soc-grid">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-[var(--color-surface-2)] focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
