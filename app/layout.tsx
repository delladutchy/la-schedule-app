import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Availability",
  description: "Professional availability viewer",
  robots: { index: false, follow: false }, // default private-ish; user can share the URL explicitly
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
