import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import starlightLlmTools from "@wave-rf/starlight-llm-tools";

export default defineConfig({
  site: "https://docs.atmyapp.com",
  integrations: [
    starlight({
      title: "AtMyApp Docs",
      description:
        "Integrate AtMyApp, define content schemas, and give clients AI-powered content control.",
      logo: {
        src: "./src/assets/logo.png",
        alt: "AtMyApp",
      },
      customCss: ["./src/styles/custom.css"],
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/At-My-App/atmyapp",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/At-My-App/atmyapp/edit/main/docs/",
      },
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://docs.atmyapp.com/social-card.png",
          },
        },
      ],
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "Quick Start", slug: "quick-start" },
          ],
        },
        {
          label: "Core Concepts",
          items: [{ label: "Schema Model", slug: "concepts/schema" }],
        },
        {
          label: "SDK Guides",
          items: [
            { label: "CLI", slug: "guides/cli" },
            { label: "Astro", slug: "guides/astro" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { label: "Core", slug: "reference/core" },
            { label: "Structure", slug: "reference/structure" },
            { label: "CLI", slug: "reference/cli" },
            { label: "Astro", slug: "reference/astro" },
          ],
        },
        {
          label: "Resources",
          items: [
            { label: "Examples", slug: "examples" },
            { label: "Changelog", slug: "changelog" },
          ],
        },
      ],
      plugins: [
        starlightLlmTools({
          title: "AtMyApp Docs",
          description:
            "Documentation for AtMyApp packages, schemas, CLI workflows, and framework integrations.",
        }),
      ],
    }),
    mdx(),
  ],
});
