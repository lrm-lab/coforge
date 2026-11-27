import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createFileRoute,
  getRouteApi,
  Outlet,
  redirect,
  useMatches,
  useRouter,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";

import { SettingsContent } from "#src/components/settings-content";
import { loadFeedbackInboxAccess } from "#src/features/feedback/feedback.functions";
import { GITHUB_CALLBACK_FAILURES } from "#src/features/integrations/github-callback";
import { bindArrivalFrom } from "#src/features/profiles/account-password-logic";
import { useAppToast } from "#src/components/ui/toast";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { SettingsPending } from "#src/features/settings/settings-pending";
import { SETTINGS_SECTIONS, type SettingsSection } from "#src/features/settings/settings-sections";
import { APPS_SETTINGS_SEARCH } from "#src/features/apps/apps-settings-search";
import { chooseAvatarPreset, saveUserProfile } from "#src/features/profiles/profile.functions";
import { MEMBER_DIRECTORY_KEY } from "#src/features/agents/member-directory-queries";
import {
  browserNotificationPermission,
  syncBrowserPushSubscription,
  shouldShowAddToHomeScreenGuide,
} from "#src/features/notifications/browser-push";
import {
  saveBrowserNotificationPreference,
  sendTestBrowserNotification,
  subscribeBrowserPush,
} from "#src/features/notifications/notifications.functions";
import {
  getUserPreferences,
  saveLanguagePreference,
  saveDateTimePreferences,
} from "#src/features/settings/settings.functions";
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";
import { getLocale, setLocale } from "#src/paraglide/runtime";
import {
  readHideEmptySidebarSections,
  writeHideEmptySidebarSections,
} from "#src/features/settings/hide-empty-sidebar-sections";
import { readMessageFullWidth, writeMessageFullWidth } from "#src/features/settings/message-width";
import { isAppError } from "#src/lib/app-error";
import type { DateTimePreferenceUpdate } from "#src/features/settings/settings.schemas";
import { syncThemeColor } from "#src/lib/theme-color";
import { m } from "#src/paraglide/messages";
import {
  loadArchivedChannels,
  loadGeneralChannelHidden,
  setGeneralChannelHidden,
} from "#src/features/conversations/channel-lifecycle.functions";
import { ArchivedChannelsGroup } from "#src/features/conversations/archived-channels-group";
import { ArchivedAgentsGroup } from "#src/features/agents/archived-agents-group";
import { loadArchivedAgents } from "#src/features/agents/agents.functions";
import { useRefreshSidebarChannels } from "#src/features/conversations/sidebar-lists";
import { WorkspaceDangerZone } from "#src/features/workspaces/workspace-danger-zone";
import {
  changeWorkspaceSlug,
  renameWorkspace,
  uploadWorkspaceIcon,
} from "#src/features/workspaces/workspaces.functions";

type Theme = "system" | "light" | "dark";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/settings")({
  validateSearch: z.object({
    section: z.enum(SETTINGS_SECTIONS).optional().catch(undefined),
    github: z
      .enum(["connected", ...GITHUB_CALLBACK_FAILURES])
      .optional()
      .catch(undefined),
    bind: z
      .union([z.literal(1), z.literal("1")])
      .optional()
      .catch(undefined),
    bindError: z
      .enum(["github_denied", "github_failed", "identity_mismatch", "unavailable"])
      .optional()
      .catch(undefined),
    ...APPS_SETTINGS_SEARCH,
  }),
  beforeLoad: ({ params, search }) => {
    if (search.section === "team-memory") {
      throw redirect({
        to: "/w/$workspaceSlug/settings/memory",
        params,
        search: { q: "", archived: false, offset: 0 },
        replace: true,
      });
    }
  },
  shouldReload: ({ cause }) => cause !== "stay",
  loader: async () => {
    const [preferences, members, generalChannel, archivedChannels, archivedAgents, feedbackAccess] =
      await Promise.all([
        getUserPreferences(),
        loadWorkspaceMembers(),
        loadGeneralChannelHidden(),
        loadArchivedChannels(),
        loadArchivedAgents(),
        loadFeedbackInboxAccess(),
      ]);
    return {
      ...preferences,
      generalChannelHidden: generalChannel?.hidden ?? null,
      archivedChannels,
      archivedAgents,
      canViewFeedbackInbox: feedbackAccess.canViewInbox,
      members: {
        actorUserId: members.actorUserId,
        actorRole: members.actorRole,
        members: members.members,
      },
    };
  },
  pendingComponent: SettingsPending,
  errorComponent: PageLoadError,
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const [hideEmptySidebarSections, setHideEmptySidebarSections] = useState(false);
  const [messageFullWidth, setMessageFullWidth] = useState(false);
  const { section, github, bind, bindError } = Route.useSearch();
  const activeRoute = useMatches({ select: (matches) => matches.at(-1)?.routeId });
  const personalMemory = activeRoute === "/w/$workspaceSlug/settings/memory_/personal";
  const memorySelected = personalMemory || activeRoute === "/w/$workspaceSlug/settings/memory";
  const bindArrival = useMemo(() => bindArrivalFrom({ bind, bindError }), [bind, bindError]);
  const navigate = Route.useNavigate();
  const {
    timeZone: savedTimeZone,
    timeFormat: savedTimeFormat,
    language: savedLanguage,
    members,
    generalChannelHidden,
    archivedChannels,
    archivedAgents,
    canViewFeedbackInbox,
  } = Route.useLoaderData();
  const { user: profile, notifications, currentWorkspace } = appRoute.useLoaderData();
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [showAddToHomeScreenGuide, setShowAddToHomeScreenGuide] = useState(false);
  const saveDateTime = useServerFn(saveDateTimePreferences);
  const saveNotificationPreference = useServerFn(saveBrowserNotificationPreference);
  const subscribePush = useServerFn(subscribeBrowserPush);
  const sendTestNotification = useServerFn(sendTestBrowserNotification);
  const saveProfile = useServerFn(saveUserProfile);
  const saveAvatarPreset = useServerFn(chooseAvatarPreset);
  const saveGeneralChannelHidden = useServerFn(setGeneralChannelHidden);
  const saveWorkspaceName = useServerFn(renameWorkspace);
  const saveWorkspaceIcon = useServerFn(uploadWorkspaceIcon);
  const saveWorkspaceSlug = useServerFn(changeWorkspaceSlug);
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const locale = savedLanguage ?? getLocale();
  const saveLanguage = useServerFn(saveLanguagePreference);

  const selectSection = useCallback(
    (next: SettingsSection) => {
      if (next === "team-memory") {
        void navigate({
          to: "/w/$workspaceSlug/settings/memory",
          search: { q: "", archived: false, offset: 0 },
        });
        return;
      }
      void navigate({ to: "/w/$workspaceSlug/settings", search: { section: next }, replace: true });
    },
    [navigate],
  );

  const dropBindArrival = useCallback(
    () => void navigate({ search: { section }, replace: true }),
    [navigate, section],
  );

  async function changeLocale(next: Parameters<typeof setLocale>[0]) {
    await saveLanguage({ data: { language: next } });
    await router.invalidate({ sync: true });
  }

  function applyTheme(nextTheme: Theme) {
    const dark =
      nextTheme === "dark" ||
      (nextTheme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark-mode", dark);
    syncThemeColor(dark);
  }

  useEffect(() => {
    const storedTheme = localStorage.getItem("coforge-theme");
    const initialTheme =
      storedTheme === "system" || storedTheme === "dark" || storedTheme === "light"
        ? storedTheme
        : "light";
    setTheme(initialTheme);
    applyTheme(initialTheme);
    setHideEmptySidebarSections(readHideEmptySidebarSections());
    setMessageFullWidth(readMessageFullWidth());
  }, []);

  useEffect(() => {
    const refreshPermission = () => setNotificationPermission(browserNotificationPermission());
    refreshPermission();
    setShowAddToHomeScreenGuide(shouldShowAddToHomeScreenGuide());
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    colorScheme.addEventListener("change", handleChange);
    return () => colorScheme.removeEventListener("change", handleChange);
  }, [theme]);

  function changeHideEmptySidebarSections(hide: boolean) {
    setHideEmptySidebarSections(hide);
    writeHideEmptySidebarSections(hide);
  }

  function changeMessageFullWidth(full: boolean) {
    setMessageFullWidth(full);
    writeMessageFullWidth(full);
  }

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    localStorage.setItem("coforge-theme", nextTheme);
    applyTheme(nextTheme);
  }

  async function changeGeneralChannelHidden(hidden: boolean) {
    await saveGeneralChannelHidden({ data: { hidden } });
    void refreshSidebarChannels();
    await router.invalidate({ sync: true });
  }

  async function changeDateTime(input: DateTimePreferenceUpdate) {
    await saveDateTime({ data: input });
    await router.invalidate({ sync: true });
  }

  async function registerCurrentBrowser(requestPermission: boolean) {
    if (!notifications.publicKey) throw new Error("Web Push is not configured");
    let permission = browserNotificationPermission();
    if (requestPermission && permission === "default")
      permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") return null;
    return syncBrowserPushSubscription(notifications.publicKey, (data) => subscribePush({ data }));
  }

  async function changeBrowserNotifications(enabled: boolean) {
    try {
      if (enabled && !(await registerCurrentBrowser(true))) return;
      await saveNotificationPreference({ data: { enabled } });
      await router.invalidate({ sync: true });
    } catch {
      toast.error(m.preferences_browser_notifications_save_error());
    }
  }

  async function enableBrowserNotifications() {
    try {
      await registerCurrentBrowser(true);
    } catch {
      toast.error(m.preferences_browser_notifications_save_error());
    }
  }

  async function testBrowserNotification() {
    try {
      const subscription = await registerCurrentBrowser(false);
      if (!subscription) throw new Error("Browser notification permission is not granted");
      const { delivery } = await sendTestNotification({
        data: { endpoint: subscription.endpoint },
      });
      return delivery;
    } catch (cause) {
      const browserFailed = !isAppError(cause) && browserNotificationPermission() === "granted";
      if (!isAppError(cause)) console.warn("browser push test failed", cause);
      toast.error(
        browserFailed
          ? m.preferences_browser_notifications_test_browser_failed()
          : m.preferences_browser_notifications_test_error(),
      );
      return null;
    }
  }

  async function refreshOwnProfile() {
    await router.invalidate({ sync: true });
    await queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY });
  }

  async function changeProfile(input: { displayName: string; description: string }) {
    await saveProfile({ data: input });
    await refreshOwnProfile();
  }

  async function changeWorkspaceName(name: string) {
    await saveWorkspaceName({ data: { name } });
    await router.invalidate({ sync: true });
  }

  const changeWorkspaceUrl = useCallback(
    async (slug: string) => {
      const workspace = await saveWorkspaceSlug({ data: { slug } });
      await navigate({
        to: "/w/$workspaceSlug/settings",
        params: { workspaceSlug: workspace.slug },
        search: { section: "workspace-profile" },
      });
    },
    [navigate, saveWorkspaceSlug],
  );

  async function changeWorkspaceIcon(file: File) {
    const form = new FormData();
    form.set("file", file);
    await saveWorkspaceIcon({ data: form });
    await router.invalidate({ sync: true });
  }

  async function uploadAvatar(file: File) {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/me/avatar", {
      method: "POST",
      body: form,
    });
    if (!response.ok) throw new Error("Profile image upload failed");
    await refreshOwnProfile();
    await queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  async function choosePresetAvatar(presetId: string) {
    await saveAvatarPreset({ data: { presetId } });
    await refreshOwnProfile();
    await queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  return (
    <SettingsContent
      bindArrival={bindArrival}
      onBindArrivalHandled={dropBindArrival}
      githubCallbackFailure={github === "connected" ? undefined : github}
      section={memorySelected ? "team-memory" : section}
      canViewFeedbackInbox={canViewFeedbackInbox}
      memoryContent={memorySelected ? <Outlet /> : undefined}
      personalMemory={personalMemory}
      onSectionChange={selectSection}
      profile={profile}
      members={members}
      locale={locale}
      theme={theme}
      timeZone={savedTimeZone}
      timeFormat={savedTimeFormat}
      browserNotificationsEnabled={notifications.enabled}
      browserNotificationPermission={notificationPermission}
      browserNotificationsConfigured={notifications.publicKey !== null}
      showAddToHomeScreenGuide={showAddToHomeScreenGuide}
      onProfileSave={changeProfile}
      onAvatarUpload={uploadAvatar}
      onAvatarPresetChoose={choosePresetAvatar}
      onLocaleChange={changeLocale}
      onThemeChange={changeTheme}
      hideEmptySidebarSections={hideEmptySidebarSections}
      onHideEmptySidebarSectionsChange={changeHideEmptySidebarSections}
      messageFullWidth={messageFullWidth}
      onMessageFullWidthChange={changeMessageFullWidth}
      onDateTimeSave={changeDateTime}
      onBrowserNotificationsChange={changeBrowserNotifications}
      onEnableBrowserNotifications={enableBrowserNotifications}
      onTestBrowserNotification={testBrowserNotification}
      generalChannelHidden={generalChannelHidden}
      onGeneralChannelHiddenSave={changeGeneralChannelHidden}
      workspace={currentWorkspace}
      onWorkspaceRename={changeWorkspaceName}
      onWorkspaceSlugChange={changeWorkspaceUrl}
      onWorkspaceIconUpload={changeWorkspaceIcon}
      archivedGroups={
        <>
          <ArchivedChannelsGroup channels={archivedChannels} timeZone={savedTimeZone} />
          <ArchivedAgentsGroup agents={archivedAgents} timeZone={savedTimeZone} />
        </>
      }
      dangerZone={
        <WorkspaceDangerZone
          workspaceName={currentWorkspace.name}
          workspaceSlug={currentWorkspace.slug}
          actorRole={members.actorRole}
        />
      }
    />
  );
}
