import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import Providers from "@/components/Providers";

const amoria = localFont({
  src: "../public/font/amoria/AMORIA.otf",
  variable: "--font-amoria",
  display: "swap",
});

const tronica = localFont({
  src: "../public/font/tronica/Tronica-Mono.otf",
  variable: "--font-tronica",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://app.cowlprotocol.com"),
  title: "Cowl · Trade unseen",
  description:
    "Private trading on Robinhood Chain. Swap from a shielded balance and hide your edge from the crowd, not from the law.",
  openGraph: {
    title: "Cowl · Trade unseen",
    description: "Private trading on Robinhood Chain. Swap from a shielded balance.",
    url: "https://app.cowlprotocol.com",
    siteName: "Cowl",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${amoria.variable} ${tronica.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-ink text-bone">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
