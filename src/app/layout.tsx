import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";
import { PUBLIC_SITE_URL, SEO_PAGES } from "@/lib/seo";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: {
    default: SEO_PAGES.home.title,
    template: "%s | Personal Touch Car Detailing",
  },
  description: SEO_PAGES.home.description,
  applicationName: "Personal Touch Car Detailing",
  category: "automotive",
  openGraph: {
    type: "website",
    locale: "en_CA",
    siteName: "Personal Touch Car Detailing",
    title: SEO_PAGES.home.title,
    description: SEO_PAGES.home.description,
    images: [{ url: "/og.png", width: 1200, height: 628, alt: "Personal Touch Car Detailing in Hamilton, Ontario" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_PAGES.home.title,
    description: SEO_PAGES.home.description,
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-CA">
      <body className={`${manrope.variable} ${instrumentSerif.variable} min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
