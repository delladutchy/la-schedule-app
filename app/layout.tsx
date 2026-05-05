import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { HydrationFlag } from "@/components/HydrationFlag";
import { BrandPrewarm } from "@/components/BrandPrewarm";

export const metadata: Metadata = {
  title: "LA Schedule",
  description: "Professional availability viewer",
  applicationName: "Jeff",
  robots: { index: false, follow: false }, // default private-ish; user can share the URL explicitly
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Jeff",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#f7f6f4" },
  ],
};

const themeInitScript = `
(() => {
  const root = document.documentElement;
  root.setAttribute("data-theme", "dark");
  try {
    const storedTheme =
      localStorage.getItem("availability-theme") ??
      localStorage.getItem("theme") ??
      localStorage.getItem("color-theme") ??
      localStorage.getItem("appearance");
    if (storedTheme === "light" || storedTheme === "dark") {
      root.setAttribute("data-theme", storedTheme);
    }
  } catch {
    // Keep the dark default when localStorage is unavailable.
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Static fallback for the in-app status bar / launch chrome.
            The viewport.themeColor entries above already provide
            light/dark-aware values; this one is the unconditional
            fallback for browsers that paint before evaluating the
            media-queried variants. */}
        <meta name="theme-color" content="#0b0b0b" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <div id="app-shell" aria-hidden="true">
          <div className="app-shell-header" />
          <div className="app-shell-toolbar" />
          <div className="app-shell-nav">
            <span />
            <span />
            <span />
          </div>
          <div className="app-shell-rows">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        {children}
        <HydrationFlag />
        <ServiceWorkerRegister />
        <BrandPrewarm />
      </body>
    </html>
  );
}
