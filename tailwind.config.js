import { colors } from "./src/styles/tokens.mjs";
const color = (name) => {
  if (!colors[name]) throw new Error(`Unknown design token ${name}`);
  return `rgb(var(--${name.replaceAll("/", "-")}-rgb) / <alpha-value>)`;
};
const group = (name) =>
  Object.fromEntries(
    Object.keys(colors)
      .filter((key) => key.startsWith(`${name}/`))
      .map((key) => [key.split("/")[1], color(key)]),
  );
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      colors: {
        ...group("bg"),
        ...group("text"),
        ...group("border"),
        action: group("action"),
        signal: group("signal"),
        danger: group("danger"),
        warning: group("warning"),
        island: group("island"),
        note: group("note"),
        "note-accent": group("note-accent"),
      },
      boxShadow: {
        popover: "0 16px 48px -8px rgb(0 0 0 / 0.14), 0 1px 2px rgb(0 0 0 / 0.06)",
        card: "0 1px 2px rgb(0 0 0 / 0.05)",
      },
    },
  },
  plugins: [],
};
