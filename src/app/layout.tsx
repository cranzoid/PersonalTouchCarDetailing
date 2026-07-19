import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Personal Touch Car Detailing | Hamilton, Ontario",
    template: "%s | Personal Touch Car Detailing",
  },
  description:
    "Professional car detailing, paint correction, ceramic coating, window tinting and vehicle styling in Hamilton, Ontario. Book online or request a quote.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-CA">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
