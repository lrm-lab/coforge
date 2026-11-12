import { createFileRoute, redirect } from "@tanstack/react-router";

import { LandingPage } from "#src/features/landing/landing-page";
import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { getStartPage } from "#src/features/workspaces/last-location.functions";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { forgetShownWorkspace } from "#src/features/workspaces/shown-workspace";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location, context, preload }) => {
    const isAuthenticated = await getAuthenticationStatus();
    if (isAuthenticated) {
      // Opening the bare app root returns to the page the user had open (24 hours), else to the
      // Workspace they last opened; a root URL carrying a query is a link with its own intent and
      // opens the Workspace.
      const start = await getStartPage({ data: { resume: !location.searchStr } });
      // In no Workspace (left or deleted the last one): create one.
      throw start ? redirect({ href: localizeHref(start) }) : redirect({ to: "/workspaces/new" });
    }
    // The public home page shows no Workspace (a session that ended while one was open). A preload
    // runs while a Workspace is still on screen, so it keeps that Workspace's cache.
    if (!preload) forgetShownWorkspace(context.queryClient);
  },
  head: () => ({
    meta: [{ title: m.landing_title() }, { name: "description", content: m.landing_description() }],
  }),
  component: LandingPage,
});
