import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";
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
  metadataBase: new URL(process.env.APP_BASE_URL ?? "http://localhost:3000"),
  title: {
    default: "Personal Touch Car Detailing | Hamilton, Ontario",
    template: "%s | Personal Touch Car Detailing",
  },
  description:
    "Professional car detailing, paint correction, ceramic coating, window tinting and vehicle styling in Hamilton, Ontario. Book online or request a quote.",
  openGraph: {
    type: "website",
    locale: "en_CA",
    title: "Personal Touch Car Detailing | Hamilton, Ontario",
    description:
      "Professional detailing, paint correction, ceramic coating, window tinting and vehicle styling in Hamilton, Ontario.",
    images: [{ url: "/og.png", width: 1200, height: 628, alt: "Personal Touch Car Detailing" }],
  },
  twitter: {
    card: "summary_large_image",
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
