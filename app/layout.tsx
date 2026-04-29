import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LA Schedule",
  description: "Professional availability viewer",
  applicationName: "LA Schedule",
  robots: { index: false, follow: false }, // default private-ish; user can share the URL explicitly
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "LA Schedule",
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
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
