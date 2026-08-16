import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "AI Ads Agent",
  description: "Run your Meta ads without ever opening Ads Manager.",
  robots: { index: false, follow: false },
  // Launch full-screen (no Safari chrome) when opened from the iOS home screen.
  appleWebApp: {
    capable: true,
    title: "Ads Agent",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#229ED9",
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
