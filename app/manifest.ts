import type { MetadataRoute } from "next";
import { BRAND_ACCENT } from "@/lib/brand";

// PWA manifest — drives the "Add to Home Screen" experience on Android/Chrome.
// iOS uses app/apple-icon.png + the appleWebApp metadata in layout.tsx instead.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Meta Ads Manager Lite",
    short_name: "Ads Lite",
    description: "Dashboard, campaigns, copy and rules for two Meta ad accounts.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: BRAND_ACCENT,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Long-press the installed app icon on Android for these quick links. (On the
    // home screen itself Android reuses one app-wide icon; per-page icons are iOS-only.)
    shortcuts: [
      {
        name: "Dashboard",
        url: "/dashboard",
        icons: [{ src: "/icon-dashboard-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Campaigns",
        url: "/campaigns",
        icons: [{ src: "/icon-campaigns-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
