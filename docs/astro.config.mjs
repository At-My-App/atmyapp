import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import starlightLlmTools from "@wave-rf/starlight-llm-tools";

export default defineConfig({
  site: "https://docs.atmyapp.com",
  // Retired pages keep working for old bookmarks and search results.
  redirects: {
    "/account/": "/concepts/how-it-works/#keys-and-urls",
    "/integrations/": "/concepts/how-it-works/#packages",
    "/concepts/schema/": "/guides/structure/",
    "/guides/cli/": "/reference/cli/",
  },
  integrations: [
    starlight({
      title: "AtMyApp Docs",
      description:
        "Connect any website to AtMyApp: model content in code, let clients edit it, and ship static or server-rendered pages.",
      logo: {
        src: "./src/assets/logo.png",
        alt: "AtMyApp",
      },
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
          },
        },
      ],
      components: {
        Header: "./src/components/shell/Header.astro",
        PageFrame: "./src/components/shell/PageFrame.astro",
        PageSidebar: "./src/components/shell/PageSidebar.astro",
        PageTitle: "./src/components/shell/PageTitle.astro",
        Sidebar: "./src/components/shell/Sidebar.astro",
        TwoColumnContent: "./src/components/shell/TwoColumnContent.astro",
      },
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
      expressiveCode: {
        themes: ["github-dark-default", "github-light-default"],
        styleOverrides: {
          borderRadius: "0.6rem",
          codeFontSize: "0.84rem",
          frames: { shadowColor: "transparent" },
        },
      },
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "How AtMyApp works", slug: "concepts/how-it-works" },
            {
              label: "Tutorial: Astro website",
              slug: "guides/astro",
              badge: { text: "Start here", variant: "tip" },
            },
            { label: "Any JavaScript website", slug: "quick-start" },
          ],
        },
        {
          label: "Model content",
          items: [
            { label: "Design your schema", slug: "guides/structure" },
            { label: "Change a live schema", slug: "guides/schema-changes" },
            { label: "Field reference", slug: "reference/fields" },
          ],
        },
        {
          label: "Read content",
          items: [
            { label: "Documents and media", slug: "guides/reading-content" },
            { label: "Collections", slug: "guides/collections" },
            { label: "Drafts and previews", slug: "guides/previews" },
          ],
        },
        {
          label: "Astro",
          items: [
            { label: "Modes and previews", slug: "guides/astro-previews" },
            { label: "Metadata and SEO", slug: "guides/astro-metadata" },
            { label: "Forms", slug: "guides/astro-forms" },
          ],
        },
        {
          label: "Forms",
          items: [
            { label: "Forms on any website", slug: "guides/forms" },
            { label: "Spam protection", slug: "guides/form-spam-protection" },
          ],
        },
        {
          label: "Ship",
          items: [
            { label: "Deploy", slug: "deployment" },
            { label: "Verify an integration", slug: "guides/diagnostics" },
            { label: "Hand over to your client", slug: "ai-assistant" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "@atmyapp/core", slug: "reference/core" },
            { label: "@atmyapp/astro", slug: "reference/astro" },
            { label: "@atmyapp/structure", slug: "reference/structure" },
            { label: "CLI", slug: "reference/cli" },
            { label: "HTTP API", slug: "reference/http-api" },
            { label: "Form limits and errors", slug: "reference/submissions" },
          ],
        },
        {
          label: "Resources",
          items: [
            { label: "Recipes", slug: "examples" },
            { label: "Changelog", slug: "changelog" },
          ],
        },
      ],
      plugins: [
        starlightLlmTools({
          title: "AtMyApp Docs",
          description:
            "Documentation for AtMyApp packages, schemas, CLI workflows, and framework integrations.",
          injectInto: false,
        }),
      ],
    }),
    mdx(),
  ],
});
