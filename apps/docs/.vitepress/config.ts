import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

// The Agent manifest JSON Schema is owned by docs/agent-manifest; the build copies it into the
// site so there is never a second committed copy.
const schemaSource = resolve(
  import.meta.dirname,
  "../../../docs/agent-manifest/coforge-agent-manifest.v1.schema.json",
);
const schemaPublishedPath = "schemas/coforge-agent-manifest.v1.schema.json";

export default defineConfig({
  title: "CoForge Developers",
  cleanUrls: true,
  srcExclude: ["AGENTS.md", "test/**"],
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
  ],
  vite: {
    plugins: [llmstxt({ domain: process.env.DOCS_ORIGIN, excludeIndexPage: false })],
  },
  buildEnd(siteConfig) {
    const target = join(siteConfig.outDir, schemaPublishedPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(schemaSource, target);
  },
  themeConfig: {
    logo: { light: "/coforge-logo-light.svg", dark: "/coforge-logo-dark.svg" },
    siteTitle: "CoForge Developers",
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      description: "Build Apps and Agent integrations on CoForge.",
      themeConfig: {
        nav: [
          { text: "Apps", link: "/apps/" },
          { text: "Build an App", link: "/build-an-app" },
          { text: "Agent manifest", link: "/agent-manifest" },
        ],
        sidebar: [
          { text: "Welcome", link: "/" },
          { text: "Apps overview", link: "/apps/" },
          { text: "Build an App", link: "/build-an-app" },
          { text: "Send events to an Agent", link: "/send-events-to-an-agent" },
          { text: "App Bot", link: "/app-bot" },
          { text: "Agent manifest", link: "/agent-manifest" },
        ],
      },
    },
    "zh-CN": {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh-CN/",
      description: "在 CoForge 上构建应用与 Agent 集成。",
      themeConfig: {
        nav: [
          { text: "应用", link: "/zh-CN/apps/" },
          { text: "构建应用", link: "/zh-CN/build-an-app" },
          { text: "Agent 清单", link: "/zh-CN/agent-manifest" },
        ],
        sidebar: [
          { text: "欢迎", link: "/zh-CN/" },
          { text: "应用概览", link: "/zh-CN/apps/" },
          { text: "构建应用", link: "/zh-CN/build-an-app" },
          { text: "向 Agent 发送事件", link: "/zh-CN/send-events-to-an-agent" },
          { text: "应用机器人", link: "/zh-CN/app-bot" },
          { text: "Agent 清单", link: "/zh-CN/agent-manifest" },
        ],
        outline: { label: "本页内容" },
        docFooter: { prev: "上一页", next: "下一页" },
        darkModeSwitchLabel: "外观",
        sidebarMenuLabel: "菜单",
        returnToTopLabel: "回到顶部",
        langMenuLabel: "切换语言",
      },
    },
  },
});
