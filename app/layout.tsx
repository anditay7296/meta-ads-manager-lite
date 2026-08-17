import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BRAND_ACCENT } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Meta Ads Manager Lite",
  description: "Dashboard, campaigns, copy and rules for two Meta ad accounts.",
  robots: { index: false, follow: false },
  // Launch full-screen (no Safari chrome) when opened from the iOS home screen.
  appleWebApp: {
    capable: true,
    title: "Ads Lite",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: BRAND_ACCENT,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
