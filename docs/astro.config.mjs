import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://proxshield.aryantah.com",
  integrations: [
    starlight({
      title: "proxshield",
      description:
        "Self-hosted firewall for LLM apps: redacts personal data before it reaches the model and blocks prompt injection.",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/aryan-tah/proxshield" }],
      editLink: { baseUrl: "https://github.com/aryan-tah/proxshield/edit/main/docs/" },
      lastUpdated: true,
      customCss: ["./src/styles/theme.css"],
      components: { PageTitle: "./src/components/PageTitle.astro" },
      sidebar: [
        {
          label: "Start here",
          items: ["getting-started", "guides/how-it-works", "guides/configuration", "guides/deploy"],
        },
        {
          label: "Use it with",
          items: [
            "integrations/openai",
            "integrations/anthropic",
            "integrations/ai-sdk",
            "integrations/other-clients",
          ],
        },
        { label: "Migrate", items: ["migrate/llm-guard", "migrate/lakera"] },
        {
          label: "Reference",
          items: ["reference/http-api", "reference/entities", "reference/benchmark", "reference/limitations"],
        },
      ],
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap",
          },
        },
      ],
    }),
  ],
});
