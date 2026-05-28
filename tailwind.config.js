/** @type {import('tailwindcss').Config} */
const config = {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
    },
    extend: {
      colors: {
        ink: {
          0:   "#FFFFFF",
          50:  "#FAFAFA",
          100: "#F4F4F5",
          200: "#E4E4E7",
          300: "#D4D4D8",
          400: "#A1A1AA",
          500: "#71717A",
          600: "#52525B",
          700: "#3F3F46",
          800: "#27272A",
          900: "#18181B",
          950: "#09090B",
        },
        accent: {
          DEFAULT: "#C8FF00",
          fg: "#0A0A0A",
          muted: "#E8FFA3",
          ring: "#9FCC00",
        },
        success: "#16A34A",
        warning: "#D97706",
        danger:  "#DC2626",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        "display-2xl": ["4.5rem", { lineHeight: "1.05", letterSpacing: "-0.035em", fontWeight: "500" }],
        "display-xl":  ["3.5rem", { lineHeight: "1.05", letterSpacing: "-0.03em",  fontWeight: "500" }],
        "display-lg":  ["2.5rem", { lineHeight: "1.1",  letterSpacing: "-0.025em", fontWeight: "500" }],
        "display":     ["2rem",   { lineHeight: "1.15", letterSpacing: "-0.02em",  fontWeight: "500" }],
      },
      letterSpacing: {
        "tightest": "-0.04em",
        "tighter":  "-0.025em",
      },
      borderRadius: {
        DEFAULT: "0.375rem",
        sm: "0.25rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
      },
      boxShadow: {
        "card":      "0 0 0 1px rgb(228 228 231 / 1), 0 1px 2px -1px rgb(24 24 27 / 0.04)",
        "card-hover":"0 0 0 1px rgb(212 212 216 / 1), 0 4px 12px -4px rgb(24 24 27 / 0.08)",
        "popover":   "0 0 0 1px rgb(228 228 231 / 1), 0 8px 24px -8px rgb(24 24 27 / 0.16)",
        "focus":     "0 0 0 3px rgb(200 255 0 / 0.30)",
      },
      transitionTimingFunction: {
        "out-cubic": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        "fade-in":     { "0%": { opacity: "0" },                 "100%": { opacity: "1" } },
        "slide-up":    { "0%": { opacity: "0", transform: "translateY(4px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "shimmer":     { "0%": { backgroundPosition: "-1000px 0" }, "100%": { backgroundPosition: "1000px 0" } },
        "marquee":     { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        "bounce-soft": { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-4px)" } },
        "lime-pulse":  { "0%,100%": { opacity: "0.55" }, "50%": { opacity: "1" } },
        "aurora-drift": {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "33%":     { transform: "translate3d(30px,-20px,0) scale(1.05)" },
          "66%":     { transform: "translate3d(-20px,25px,0) scale(0.95)" },
        },
        "aurora-drift-alt": {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "33%":     { transform: "translate3d(-25px,15px,0) scale(0.97)" },
          "66%":     { transform: "translate3d(20px,-30px,0) scale(1.08)" },
        },
      },
      animation: {
        "fade-in":          "fade-in 0.18s ease-out",
        "slide-up":         "slide-up 0.22s cubic-bezier(0.22, 1, 0.36, 1)",
        "shimmer":          "shimmer 2s linear infinite",
        "marquee":          "marquee var(--marquee-speed, 40s) linear infinite",
        "bounce-soft":      "bounce-soft 3.2s ease-in-out infinite",
        "lime-pulse":       "lime-pulse 4s ease-in-out infinite",
        "aurora-drift":     "aurora-drift 18s ease-in-out infinite",
        "aurora-drift-alt": "aurora-drift-alt 22s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
