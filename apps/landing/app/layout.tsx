import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Mona_Sans } from "next/font/google";
import { openGraph, site } from "@/lib/site";
import "./globals.css";

const mona = Mona_Sans({ subsets: ["latin"], variable: "--font-mona" });
const fragment = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-fragment" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: "%s | VM Bridge" },
  description: site.description,
  applicationName: site.name,
  openGraph: { ...openGraph, title: site.title, description: site.description },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/logo.svg", apple: "/apple-icon.png" },
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mona.variable} ${fragment.variable}`}>
      <body>{children}</body>
    </html>
  );
}
