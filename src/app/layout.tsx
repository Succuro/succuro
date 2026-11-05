import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { BRAND } from "@/domain/brand";
import "./globals.css";

const sans = Geist({ variable: "--font-brand-sans", subsets: ["latin"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-brand-mono", subsets: ["latin"], display: "swap" });
const serif = Instrument_Serif({ variable: "--font-brand-serif", subsets: ["latin"], weight: "400", style: "italic", display: "swap" });

export const metadata: Metadata = {
  title: { default: BRAND, template: `%s · ${BRAND}` },
  description: "One support desk for all your products, from a screen or from your assistant.",
  robots: { index: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable} ${serif.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
