import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Availability",
  description: "Professional availability viewer",
  robots: { index: false, follow: false }, // default private-ish; user can share the URL explicitly
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
