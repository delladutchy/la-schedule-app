import type { MetadataRoute } from "next";

// Intentionally omits `start_url` so each user's saved Home Screen icon
// preserves the URL that was active when they tapped Add to Home Screen
// (including any editor-link `?editor=TOKEN` query string).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jeff",
    short_name: "Jeff",
    description: "Professional availability viewer",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.png", sizes: "180x180", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
