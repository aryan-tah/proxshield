import { defineEcConfig } from "@astrojs/starlight/expressive-code";

const dark = (t) => t.type === "dark";

export default defineEcConfig({
  themes: ["github-dark-default", "github-light-default"],
  styleOverrides: {
    borderRadius: "0.5rem",
    borderColor: ({ theme }) => (dark(theme) ? "#1f1f1f" : "#e8e8e8"),
    codeFontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    codeFontSize: "0.8125rem",
    codeBackground: ({ theme }) => (dark(theme) ? "#0a0a0a" : "#fafafa"),
    frames: {
      shadowColor: "transparent",
      editorTabBarBackground: ({ theme }) => (dark(theme) ? "#0a0a0a" : "#fafafa"),
      editorActiveTabBackground: ({ theme }) => (dark(theme) ? "#0a0a0a" : "#fafafa"),
      editorActiveTabIndicatorTopColor: "transparent",
      editorTabBarBorderBottomColor: ({ theme }) => (dark(theme) ? "#1f1f1f" : "#e8e8e8"),
      terminalTitlebarBackground: ({ theme }) => (dark(theme) ? "#0a0a0a" : "#fafafa"),
      terminalBackground: ({ theme }) => (dark(theme) ? "#0a0a0a" : "#fafafa"),
      terminalTitlebarBorderBottomColor: ({ theme }) => (dark(theme) ? "#1f1f1f" : "#e8e8e8"),
      terminalTitlebarDotsOpacity: "0.2",
    },
  },
});
