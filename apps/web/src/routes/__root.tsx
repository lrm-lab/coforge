import { useCallback } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/react-router";
import { LazyMotion } from "motion/react";
import { RouterProvider } from "react-aria-components";

import { Favicon } from "#src/components/foundations/logo/favicon";
import { AppToastProvider } from "#src/components/ui/toast";
import { HeldEnterGuard } from "#src/hooks/held-enter";
import { getLocale } from "#src/paraglide/runtime";

import appCss from "#src/styles.css?url";

import { SIDEBAR_EXPANDED_BOOT } from "#src/features/settings/sidebar-expanded";
import { HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT } from "#src/features/settings/hide-empty-sidebar-sections";
import { MESSAGE_WIDTH_BOOT } from "#src/features/settings/message-width";
import { MESSAGE_FONT_SIZE_BOOT } from "#src/features/settings/message-font-size";
import { CONVERSATION_LIST_BOOT } from "#src/features/conversations/conversation-list-width";
import { TASK_HIDDEN_COLUMNS_BOOT } from "#src/features/settings/task-hidden-columns";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { BuildUpdateWatcher } from "#src/features/updates/build-update-watcher";
import { MenuHighlightTracker } from "#src/lib/menu-highlight";
import { DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "#src/lib/theme-color";
const themeScript = `try{var theme=localStorage.getItem("coforge-theme");var dark=theme==="dark"||(theme==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);if(dark){document.documentElement.classList.add("dark-mode")}${SIDEBAR_EXPANDED_BOOT}${CONVERSATION_LIST_BOOT}${HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT}${MESSAGE_WIDTH_BOOT}${MESSAGE_FONT_SIZE_BOOT}${TASK_HIDDEN_COLUMNS_BOOT}}catch{}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      {
        name: "color-scheme",
        content: "light dark",
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: LIGHT_THEME_COLOR,
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: DARK_THEME_COLOR,
      },
      {
        name: "mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-title",
        content: "CoForge",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "default",
      },
      {
        title: "CoForge",
      },
    ],
    links: [
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "manifest",
        href: "/manifest.webmanifest",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

const HOTKEY_DEFAULTS = { hotkey: { ignoreDefaultPrevented: true } };

const loadMotionFeatures = () =>
  import("#src/components/ui/motion-features").then((mod) => mod.default);

function RootDocument({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const navigate = useCallback(
    (href: string) => {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) {
        window.location.assign(url.href);
        return;
      }
      void router.navigate({ href: url.pathname + url.search + url.hash });
    },
    [router],
  );
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
        <Favicon />
      </head>
      <body>
        <HeldEnterGuard />
        <MenuHighlightTracker />
        <RouterProvider navigate={navigate}>
          <HotkeysProvider defaultOptions={HOTKEY_DEFAULTS}>
            <LazyMotion features={loadMotionFeatures} strict>
              <AppToastProvider>
                <BuildUpdateWatcher />
                <div id="coforge-app-root" className="isolate">
                  {children}
                </div>
              </AppToastProvider>
            </LazyMotion>
          </HotkeysProvider>
        </RouterProvider>
        <Scripts />
      </body>
    </html>
  );
}
