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
      sidebar: [
        {
          label: "Start here",
          items: [
            {
              label: "Introduction",
              slug: "index",
            },
            {
              label: "JavaScript setup",
              slug: "quick-start",
            },
            {
              label: "How content works",
              slug: "concepts/schema",
            },
          ],
        },
        {
          label: "Model your content",
          items: [
            {
              label: "Define a schema",
              slug: "guides/structure",
            },
            {
              label: "Field types and options",
              slug: "reference/fields",
            },
            {
              label: "CLI workflow",
              slug: "guides/cli",
            },
          ],
        },
        {
          label: "Astro",
          items: [
            {
              label: "Setup",
              slug: "guides/astro",
            },
            {
              label: "Modes and previews",
              slug: "guides/astro-previews",
            },
            {
              label: "Metadata and SEO",
              slug: "guides/astro-metadata",
            },
            {
              label: "Forms",
              slug: "guides/astro-forms",
            },
          ],
        },
        {
          label: "Ship and hand over",
          items: [
            {
              label: "Forms with JavaScript",
              slug: "guides/forms",
            },
            {
              label: "Deployment",
              slug: "deployment",
            },
            {
              label: "Verify your integration",
              slug: "guides/diagnostics",
            },
            {
              label: "Client handoff",
              slug: "ai-assistant",
            },
            {
              label: "Troubleshooting",
              slug: "troubleshooting",
            },
          ],
        },
        {
          label: "API reference",
          items: [
            {
              label: "Core SDK",
              slug: "reference/core",
            },
            {
              label: "Structure SDK",
              slug: "reference/structure",
            },
            {
              label: "Astro SDK",
              slug: "reference/astro",
            },
            {
              label: "CLI",
              slug: "reference/cli",
            },
          ],
        },
        {
          label: "Resources",
          items: [
            {
              label: "Examples",
              slug: "examples",
            },
            {
              label: "Integrations",
              slug: "integrations",
            },
            {
              label: "Account",
              slug: "account",
            },
            {
              label: "Changelog",
              slug: "changelog",
            },
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
