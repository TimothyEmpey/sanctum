import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = localFont({
  src:"./fonts/geist.woff2",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src:"./fonts/geist-mono.woff2",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Uriel",
  description: "NQ and ES futures desk with a shared risk engine.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#6d28d9",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
