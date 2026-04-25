"use client";

type Theme = "dark" | "light";

const THEME_STORAGE_KEYS = ["availability-theme", "theme", "color-theme", "appearance"] as const;

function readSavedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    for (const key of THEME_STORAGE_KEYS) {
      const value = window.localStorage.getItem(key);
      if (value === "dark" || value === "light") return value;
    }
  } catch {
    // Ignore storage read issues and keep the current document theme.
  }
  return null;
}

function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem("availability-theme", theme);
    } catch {
      // Ignore storage write issues; theme still updates for this session.
    }
  }
}

export function ThemeToggle() {
  const onToggle = () => {
    const activeTheme = readSavedTheme() ?? currentTheme();
    const nextTheme: Theme = activeTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  };

  return (
    <button
      type="button"
      className="theme-toggle-button"
      aria-label="Toggle theme"
      title="Toggle theme"
      onClick={onToggle}
    >
      <svg
        className="theme-toggle-icon theme-toggle-icon--dark"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3c0.04 0 0.08 0 0.12 0a7 7 0 0 0 9.67 9.67z" />
      </svg>
      <svg
        className="theme-toggle-icon theme-toggle-icon--light"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2" x2="12" y2="5" />
        <line x1="12" y1="19" x2="12" y2="22" />
        <line x1="2" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="22" y2="12" />
        <line x1="4.9" y1="4.9" x2="7" y2="7" />
        <line x1="17" y1="17" x2="19.1" y2="19.1" />
        <line x1="17" y1="7" x2="19.1" y2="4.9" />
        <line x1="4.9" y1="19.1" x2="7" y2="17" />
      </svg>
    </button>
  );
}
