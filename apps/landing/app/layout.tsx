import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Mona_Sans } from "next/font/google";
import "./globals.css";

const mona = Mona_Sans({ subsets: ["latin"], variable: "--font-mona" });
const fragment = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-fragment" });

export const metadata: Metadata = {
  title: { default: "VM Bridge: T3 Code on cloud VMs", template: "%s | VM Bridge" },
  description:
    "Pair T3 Code once. VM Bridge gives each project its own cloud VM, puts it to sleep when idle and wakes it when you send a message.",
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mona.variable} ${fragment.variable}`}>
      <body>{children}</body>
    </html>
  );
}
