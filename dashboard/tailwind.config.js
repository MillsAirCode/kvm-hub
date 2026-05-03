/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: { 950: "#0a0a0d", 900: "#11121a", 800: "#1a1c2a", 700: "#272a3d", 600: "#3b3f57" },
        // Accent palette reads CSS variables defined in index.css :root,
        // letting Settings → THEME ACCENT swap tint at runtime (Emerald /
        // Violet / Rose). Tailwind's `rgb(var(--x) / <alpha-value>)` form
        // works with opacity-modified utilities (bg-accent/15 etc).
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          glow:    "rgb(var(--accent-glow-rgb) / <alpha-value>)",
          dim:     "rgb(var(--accent-dim-rgb) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
