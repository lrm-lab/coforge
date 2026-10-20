import type { CompilerOptions } from "@inlang/paraglide-js";

import { NON_LOCALIZED_PAGES } from "./src/lib/non-localized-path";

/** How a page resolves its locale: the URL's prefix first. */
const strategy = ["url", "cookie", "preferredLanguage", "baseLocale"] as const;

export const paraglideOptions = {
  project: "./project.inlang",
  outdir: "./src/paraglide",
  outputStructure: "message-modules",
  cookieName: "PARAGLIDE_LOCALE",
  strategy: [...strategy],
  // A page served without a locale prefix resolves its locale as the browser does, minus the URL,
  // so the server renders what hydration renders. https://paraglidejs.com/strategy
  routeStrategies: NON_LOCALIZED_PAGES.map((match) => ({
    match,
    strategy: strategy.filter((step) => step !== "url"),
  })),
  urlPatterns: [
    {
      pattern: "/",
      localized: [
        ["en", "/en"],
        ["zh-CN", "/zh-CN"],
      ],
    },
    {
      pattern: "/:path(.*)?",
      localized: [
        ["en", "/en/:path(.*)?"],
        ["zh-CN", "/zh-CN/:path(.*)?"],
      ],
    },
  ],
} satisfies CompilerOptions;
