import { createFileRoute, redirect } from "@tanstack/react-router";

import { LandingPage } from "#src/features/landing/landing-page";
import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { getStartPage } from "#src/features/workspaces/last-location.functions";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { forgetShownWorkspace } from "#src/features/workspaces/shown-workspace";

const SHORTCUT_SECTIONS = new Set(["chat", "activity", "workspace", "tasks"] as const);
type ShortcutSection = "chat" | "activity" | "workspace" | "tasks";

function parseShortcutSection(searchStr: string): ShortcutSection | undefined {
  const value = new URLSearchParams(searchStr).get("shortcut");
  if (!value) return undefined;
  return SHORTCUT_SECTIONS.has(value as ShortcutSection) ? (value as ShortcutSection) : undefined;
}

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location, context, preload }) => {
    const isAuthenticated = await getAuthenticationStatus();
    if (isAuthenticated) {
      const section = parseShortcutSection(location.searchStr);
      const start = await getStartPage({ data: { resume: !location.searchStr, section } });
      throw start ? redirect({ href: localizeHref(start) }) : redirect({ to: "/workspaces/new" });
    }
    if (!preload) forgetShownWorkspace(context.queryClient);
  },
  head: () => ({
    meta: [{ title: m.landing_title() }, { name: "description", content: m.landing_description() }],
  }),
  component: LandingPage,
});
