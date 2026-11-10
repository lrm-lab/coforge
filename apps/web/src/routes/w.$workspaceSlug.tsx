import { Suspense, lazy, useCallback, useEffect } from "react";
import { getLocale, setLocale } from "#src/paraglide/runtime";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, notFound, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppShell } from "#src/components/app-shell";
import { ComputerUpgradeWatcher } from "#src/features/computers/computer-upgrade-watcher";
import { TimeFormatProvider } from "#src/lib/time-format-context";
import { TimeZoneProvider } from "#src/lib/time-zone-context";
import { loadAssumedPhone } from "#src/features/settings/assumed-viewport.functions";
import { loadCookieTimeZone } from "#src/features/settings/time-zone-cookie.functions";
import { useTimeZoneCookie } from "#src/features/settings/use-time-zone-cookie";
import { AssumedViewportProvider } from "#src/hooks/assumed-viewport";
import { getUserProfile } from "#src/features/profiles/profile.functions";
import {
  loadWorkspaceSwitcher,
  openWorkspace,
} from "#src/features/workspaces/workspaces.functions";
import { useCreateAndOpenWorkspace } from "#src/features/workspaces/create-workspace-form";
import { isAppError } from "#src/lib/app-error";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { splitWorkspacePath, workspacePath } from "#src/features/workspaces/workspace-url";
import { recordsNavAttentionQuery } from "#src/features/records/records-nav-attention";
import { BrowserRealtimeProvider } from "#src/features/realtime/browser-realtime";
import { getBrowserRealtimeConnectionToken } from "#src/features/realtime/realtime.functions";
import { BrowserPushLifecycle } from "#src/features/notifications/browser-push-lifecycle";
import { InPageNotifications } from "#src/features/notifications/in-page-notifications";
import { ComputerActivityReport } from "#src/features/notifications/use-computer-activity-report";
import { NotificationActivationProvider } from "#src/features/notifications/notification-activation-banner";
import { getBrowserNotificationSettings } from "#src/features/notifications/notifications.functions";
import { loadWorkspaceAgents } from "#src/features/agents/workspace-agents.functions";
import { WorkspaceAgentsProvider } from "#src/features/agents/workspace-agents-realtime";
import { WorkspacePresenceProvider } from "#src/features/workspaces/member-presence";
import { getUserPreferences } from "#src/features/settings/settings.functions";
import { loadAiWorkbenchOn } from "#src/features/pi-chat/pi-chat.functions";
import { useAiWorkbenchEnabled } from "#src/features/settings/ai-workbench";
import { loadMemberWorkspaceSettings } from "#src/features/workspaces/member-settings.functions";
import { loadOnboardingWizard } from "#src/features/onboarding/onboarding-wizard.functions";
import { PanelTabOrderProvider } from "#src/features/panel-tabs/panel-tab-order-context";
import { useLastLocationMemory } from "#src/features/workspaces/use-last-location-memory";
import { SearchDialogHost } from "#src/features/search/search-dialog-host";
import { useSidebarShortcut } from "#src/features/settings/sidebar-shortcut";
import { markShownWorkspace, shownWorkspace } from "#src/features/workspaces/shown-workspace";
import { LeaveDeletedWorkspace } from "#src/features/workspaces/leave-deleted-workspace";
import { ReferencedTasksRealtime } from "#src/features/tasks/referenced-task";
import {
  otherTaskParamSchema,
  parseOtherTask,
  useOtherTaskParam,
} from "#src/features/tasks/other-task-search";
import { getStartPage } from "#src/features/workspaces/last-location.functions";
import { rememberQueryCache } from "#src/features/cache-persistence/browser-query-cache";
import { nameStepRedirect } from "#src/features/auth/name-step-redirect";
import { signOut } from "#src/features/auth/sign-out";

// Only a member in their first-sign-in setup ever loads it.
const OnboardingWizard = lazy(() =>
  import("#src/features/onboarding/onboarding-wizard").then((module) => ({
    default: module.OnboardingWizard,
  })),
);

// Only a press on another conversation's Task loads the conversation UI on a page without one.
const OtherTaskPopup = lazy(() =>
  import("#src/features/tasks/other-task-popup").then((module) => ({
    default: module.OtherTaskPopup,
  })),
);

export const Route = createFileRoute("/w/$workspaceSlug")({
  staleTime: Infinity,
  validateSearch: z.object({ otherTask: otherTaskParamSchema }),
  beforeLoad: async ({ params, context, preload, location }) => {
    // A malformed slug names no Workspace; server calls would fall back to the remembered one.
    if (!isValidWorkspaceSlug(params.workspaceSlug)) throw notFound();
    // A preload runs while the browser URL still names the Workspace on screen: it must neither
    // check the target Workspace against that one nor clear what is on screen.
    if (preload) return;
    const shown = shownWorkspace(context.queryClient);
    if (shown === params.workspaceSlug) return;
    // Runs before any page loader: a Workspace the User is not in is a page that does not exist
    // for them. Checked once per Workspace entered; every server call re-checks it anyway.
    const opened = await openWorkspace().catch(async (error: unknown) => {
      if (!isAppError(error) || error.code !== "NOT_FOUND") throw error;
      // A person in no Workspace at all has nowhere to go from here but creating one.
      if (!(await getStartPage({ data: { resume: false } })))
        throw redirect({ to: "/workspaces/new" });
      throw notFound();
    });
    // Query keys are not scoped by Workspace, so moving to another one starts from an empty cache.
    if (shown && shown !== opened.slug) context.queryClient.clear();
    markShownWorkspace(context.queryClient, opened.slug);
    // A former slug still names its Workspace: the same page under the current one. It is marked
    // shown above, so the redirected load does not open it again.
    if (opened.slug !== params.workspaceSlug)
      throw redirect({
        href: workspacePath(opened.slug, splitWorkspacePath(location.href)?.rest),
        replace: true,
      });
  },
  loader: async ({ location, params, context }) => {
    const [
      user,
      switcher,
      notifications,
      workspaceAgents,
      preferences,
      memberSettings,
      aiWorkbenchEnabled,
    ] = await Promise.all([
      getUserProfile(),
      loadWorkspaceSwitcher(),
      getBrowserNotificationSettings(),
      loadWorkspaceAgents(),
      getUserPreferences(),
      loadMemberWorkspaceSettings(),
      loadAiWorkbenchOn(),
      // Shown at once from the cache, and read again in the background once older than its
      // staleTime, as each run of this loader read it before (task #366).
      context.queryClient.ensureQueryData({
        ...recordsNavAttentionQuery(params.workspaceSlug),
        revalidateIfStale: true,
      }),
    ]);
    // A person who has not been asked for a display name is asked once, here for a session that
    // predates the step, and comes back to this page.
    if (!user.named) throw nameStepRedirect(location.href);
    // The setup wizard shows over the Workspace while the member's first-sign-in mark is set. The
    // mark came with their settings, so a member who finished it costs no further read; one still
    // in it gets the wizard's state with the page, not after a request of its own.
    const onboarding = memberSettings.setupPending ? await loadOnboardingWizard() : null;
    return {
      user,
      workspaces: switcher.workspaces,
      currentWorkspace: switcher.current,
      canCreateAgents: switcher.canCreateAgents,
      canSeeUsageLimits: switcher.canSeeUsageLimits,
      onboarding,
      notifications,
      agents: workspaceAgents.agents,
      extraAgents: workspaceAgents.extraAgents,
      statusAgents: workspaceAgents.statusAgents,
      agentStreamPositions: workspaceAgents.streamPositions,
      timeZone: preferences.timeZone,
      // The browser's zone, which the server knows only from the cookie the page writes, and when
      // this ran: together the render's clock, so a list grouped by day is grouped before hydration
      // the same way the browser hydrates it (task #68).
      cookieTimeZone: loadCookieTimeZone() ?? null,
      renderedAt: Date.now(),
      assumedPhone: loadAssumedPhone(),
      timeFormat: preferences.timeFormat,
      language: preferences.language,
      aiWorkbenchEnabled,
      tabOrders: memberSettings.tabOrders,
    };
  },
  component: AppLayout,
});

function AppLayout() {
  const {
    user,
    workspaces,
    currentWorkspace,
    agents,
    extraAgents,
    statusAgents,
    agentStreamPositions,
    notifications,
    timeZone,
    cookieTimeZone,
    renderedAt,
    assumedPhone,
    timeFormat,
    language,
    aiWorkbenchEnabled,
    tabOrders,
    onboarding,
    canSeeUsageLimits,
  } = Route.useLoaderData();
  const { queryClient } = Route.useRouteContext();
  const recordsPreview =
    useQuery(recordsNavAttentionQuery(currentWorkspace.slug)).data?.preview ?? false;
  // Hydration does not re-run `beforeLoad`, so the browser learns here which Workspace the server
  // rendered; otherwise the first switch away would keep this Workspace's cache.
  useEffect(() => {
    markShownWorkspace(queryClient, currentWorkspace.slug);
  }, [queryClient, currentWorkspace.slug]);
  // Reads that finished before the person was known wrote nothing: store them now, so the next page
  // load opens from them (`features/cache-persistence/`).
  useEffect(() => {
    void rememberQueryCache(queryClient);
  }, [queryClient, currentWorkspace.slug]);
  // The language saved in Settings is the person's, on every page of the Workspace: an address
  // in another language (a link someone shared) switches to it, rather than only Settings did.
  useEffect(() => {
    if (language && language !== getLocale()) setLocale(language);
  }, [language]);
  const aiWorkbench = useAiWorkbenchEnabled(aiWorkbenchEnabled);
  useLastLocationMemory();
  useTimeZoneCookie();
  useSidebarShortcut();
  const getRealtimeToken = useServerFn(getBrowserRealtimeConnectionToken);
  const getConnectionToken = useCallback(() => getRealtimeToken(), [getRealtimeToken]);
  const navigate = useNavigate();
  const createAndOpen = useCreateAndOpenWorkspace();
  const otherTask = parseOtherTask(useOtherTaskParam());
  return (
    <TimeFormatProvider timeFormat={timeFormat}>
      <TimeZoneProvider saved={timeZone} cookie={cookieTimeZone} renderedAt={renderedAt}>
        <AssumedViewportProvider phone={assumedPhone}>
          <BrowserRealtimeProvider
            workspaceId={currentWorkspace.id}
            getConnectionToken={getConnectionToken}
          >
            <WorkspacePresenceProvider workspaceId={currentWorkspace.id}>
              <WorkspaceAgentsProvider
                workspaceId={currentWorkspace.id}
                viewerId={user.id}
                agents={agents}
                extraAgents={extraAgents}
                statusAgents={statusAgents}
                agentStreamPositions={agentStreamPositions}
              >
                <PanelTabOrderProvider workspaceId={currentWorkspace.id} orders={tabOrders}>
                  <SearchDialogHost
                    workspaceId={currentWorkspace.id}
                    viewerId={user.id}
                    timeZone={timeZone}
                  >
                    {/* Every open page leaves a Workspace its owner deleted. */}
                    <LeaveDeletedWorkspace workspaceId={currentWorkspace.id} />
                    <ReferencedTasksRealtime workspaceId={currentWorkspace.id} userId={user.id} />
                    {/* The server prunes dead web-push subscriptions (404/410), and nothing else ever
            re-registers them — without this the phone stays silent until a manual toggle. */}
                    <BrowserPushLifecycle
                      enabled={notifications.enabled}
                      publicKey={notifications.publicKey}
                    />
                    {/* While a tab is open, show the OS notification here instead of relying on
                Web Push, which mainland-China staging/clients cannot reach for Chrome. */}
                    <InPageNotifications
                      enabled={notifications.enabled}
                      viewerId={user.id}
                      workspaceId={currentWorkspace.id}
                    />
                    {/* Says when the person is at this computer, so a phone's notifications can wait. */}
                    <ComputerActivityReport enabled={notifications.enabled} />
                    <ComputerUpgradeWatcher />
                    {onboarding && (
                      <Suspense fallback={null}>
                        <OnboardingWizard
                          workspaceId={currentWorkspace.id}
                          workspaceSlug={currentWorkspace.slug}
                          initial={onboarding}
                        />
                      </Suspense>
                    )}
                    <NotificationActivationProvider
                      value={{
                        publicKey: notifications.publicKey,
                        workspaceSlug: currentWorkspace.slug,
                      }}
                    >
                      <AppShell
                        user={{
                          id: user.id,
                          name: user.name,
                          email: user.email,
                          avatarUrl: user.avatarUrl,
                        }}
                        workspaces={workspaces}
                        currentWorkspace={currentWorkspace}
                        recordsPreview={recordsPreview}
                        aiWorkbench={aiWorkbench}
                        canSeeUsageLimits={canSeeUsageLimits}
                        onSelectWorkspace={async (slug) => {
                          await navigate({
                            to: "/w/$workspaceSlug",
                            params: { workspaceSlug: slug },
                          });
                        }}
                        onCreateWorkspace={createAndOpen}
                        /** Like FirstWorkspacePage's link: a full browser navigation so the server route
                         * can clear the session cookie and send the browser to Authing. `?returnTo`
                         * carries this page back across the sign-out (the root route hands it to
                         * `/login`) once the switch-account return step is in. */
                        onSignOut={() => void signOut()}
                      >
                        <Outlet />
                        {otherTask && (
                          <Suspense fallback={null}>
                            <OtherTaskPopup task={otherTask} />
                          </Suspense>
                        )}
                      </AppShell>
                    </NotificationActivationProvider>
                  </SearchDialogHost>
                </PanelTabOrderProvider>
              </WorkspaceAgentsProvider>
            </WorkspacePresenceProvider>
          </BrowserRealtimeProvider>
        </AssumedViewportProvider>
      </TimeZoneProvider>
    </TimeFormatProvider>
  );
}
