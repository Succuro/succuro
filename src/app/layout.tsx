import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Mono, Figtree } from "next/font/google";
import { BRAND } from "@/domain/brand";
import "./globals.css";

const sans = Figtree({ variable: "--font-brand-sans", subsets: ["latin"], display: "swap" });
const heading = Bricolage_Grotesque({ variable: "--font-brand-heading", subsets: ["latin"], display: "swap" });
const mono = DM_Mono({ variable: "--font-brand-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  // Where the social card is served from; a build that doesn't know its address leaves it to the platform.
  metadataBase: process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined,
  title: { default: BRAND, template: `%s · ${BRAND}` },
  description: "One support desk for all your products, from a screen or from your assistant.",
  robots: { index: false },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf6" },
    { media: "(prefers-color-scheme: dark)", color: "#0a120f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${heading.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
