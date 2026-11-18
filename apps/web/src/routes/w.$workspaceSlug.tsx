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
import { artifactIdOfWorkspaceRest } from "#src/features/artifacts/artifact-search";
import { artifactVisitorUrl } from "#src/features/artifacts/artifact-visitor.functions";
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

const OnboardingWizard = lazy(() =>
  import("#src/features/onboarding/onboarding-wizard").then((module) => ({
    default: module.OnboardingWizard,
  })),
);

const OtherTaskPopup = lazy(() =>
  import("#src/features/tasks/other-task-popup").then((module) => ({
    default: module.OtherTaskPopup,
  })),
);

export const Route = createFileRoute("/w/$workspaceSlug")({
  staleTime: Infinity,
  validateSearch: z.object({ otherTask: otherTaskParamSchema }),
  beforeLoad: async ({ params, context, preload, location }) => {
    if (!isValidWorkspaceSlug(params.workspaceSlug)) throw notFound();
    if (preload) return;
    const shown = shownWorkspace(context.queryClient);
    if (shown === params.workspaceSlug) return;
    const artifactId = artifactIdOfWorkspaceRest(splitWorkspacePath(location.href)?.rest);
    if (artifactId) {
      const visitorUrl = await artifactVisitorUrl({
        data: { workspaceSlug: params.workspaceSlug, artifactId },
      }).catch(() => null);
      if (visitorUrl) throw redirect({ href: visitorUrl, replace: true });
    }
    const opened = await openWorkspace().catch(async (error: unknown) => {
      if (!isAppError(error) || error.code !== "NOT_FOUND") throw error;
      if (!(await getStartPage({ data: { resume: false } })))
        throw redirect({ to: "/workspaces/new" });
      throw notFound();
    });
    if (shown && shown !== opened.slug) context.queryClient.clear();
    markShownWorkspace(context.queryClient, opened.slug);
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
      context.queryClient.ensureQueryData({
        ...recordsNavAttentionQuery(params.workspaceSlug),
        revalidateIfStale: true,
      }),
    ]);
    if (!user.named) throw nameStepRedirect(location.href);
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
      cookieTimeZone: loadCookieTimeZone() ?? null,
      observedTimeZone: preferences.observedTimeZone ?? null,
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
    observedTimeZone,
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
  useEffect(() => {
    markShownWorkspace(queryClient, currentWorkspace.slug);
  }, [queryClient, currentWorkspace.slug]);
  useEffect(() => {
    void rememberQueryCache(queryClient);
  }, [queryClient, currentWorkspace.slug]);
  useEffect(() => {
    if (language && language !== getLocale()) setLocale(language);
  }, [language]);
  const aiWorkbench = useAiWorkbenchEnabled(aiWorkbenchEnabled);
  useLastLocationMemory();
  useTimeZoneCookie(observedTimeZone);
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
                    <LeaveDeletedWorkspace workspaceId={currentWorkspace.id} />
                    <ReferencedTasksRealtime workspaceId={currentWorkspace.id} userId={user.id} />
                    <BrowserPushLifecycle
                      enabled={notifications.enabled}
                      publicKey={notifications.publicKey}
                    />
                    <InPageNotifications
                      enabled={notifications.enabled}
                      viewerId={user.id}
                      workspaceId={currentWorkspace.id}
                    />
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
