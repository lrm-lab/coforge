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
import { MEMBER_PAGE_SIZE } from "#src/features/workspaces/member-directory";
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
  loadMemberAgentPage,
  renameWorkspace,
  uploadWorkspaceIcon,
} from "#src/features/workspaces/workspaces.functions";

type Theme = "system" | "light" | "dark";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/settings")({
  // The section lives in the URL so it survives the full reload a locale
  // switch triggers and so a settings link can open a specific section.
  validateSearch: z.object({
    section: z.enum(SETTINGS_SECTIONS).optional().catch(undefined),
    github: z
      .enum(["connected", ...GITHUB_CALLBACK_FAILURES])
      .optional()
      .catch(undefined),
    // The way back from GitHub's confirmation of who is adding a contact (`?bind=1`, or why not).
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
  // The loader reads nothing from the search. A navigation that stays on Settings (a section, the
  // Applications tab or category, clicking the one already open) does not re-run it; entering the
  // page and `router.invalidate()` after a save still do.
  shouldReload: ({ cause }) => cause !== "stay",
  loader: async () => {
    const [preferences, members, generalChannel, archivedChannels, archivedAgents, createdAgents] =
      await Promise.all([
        getUserPreferences(),
        loadWorkspaceMembers(),
        loadGeneralChannelHidden(),
        loadArchivedChannels(),
        loadArchivedAgents(),
        loadMemberAgentPage({ data: { owner: "mine", query: "", limit: MEMBER_PAGE_SIZE } }),
      ]);
    return {
      ...preferences,
      createdAgents: createdAgents.items.map(({ id, name, avatarUrl }) => ({
        id,
        name,
        avatarUrl,
      })),
      generalChannelHidden: generalChannel?.hidden ?? null,
      archivedChannels,
      archivedAgents,
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
    createdAgents,
    generalChannelHidden,
    archivedChannels,
    archivedAgents,
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

  function selectSection(next: SettingsSection) {
    if (next === "team-memory") {
      void navigate({
        to: "/w/$workspaceSlug/settings/memory",
        search: { q: "", archived: false, offset: 0 },
      });
      return;
    }
    void navigate({ to: "/w/$workspaceSlug/settings", search: { section: next }, replace: true });
  }

  const dropBindArrival = useCallback(
    () => void navigate({ search: { section }, replace: true }),
    [navigate, section],
  );

  async function changeLocale(next: Parameters<typeof setLocale>[0]) {
    await saveLanguage({ data: { language: next } });
    // The stored preference is the source of truth: re-reading it has the Workspace layout switch
    // the page to it, as it does on every page.
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

  // Hiding #general changes the sidebar's channel list too; its realtime signal also refreshes
  // other open pages.
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
      // The test button is only enabled once permission is granted; "Allow in browser" asks for it.
      const subscription = await registerCurrentBrowser(false);
      if (!subscription) throw new Error("Browser notification permission is not granted");
      const { delivery } = await sendTestNotification({
        data: { endpoint: subscription.endpoint },
      });
      return delivery;
    } catch (cause) {
      // A client-side failure with the permission granted is the browser's own push service
      // refusing to create the subscription; name that, and put the raw reason in the console.
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

  /** After the viewer's own name, description or picture changed: the page, and the Members
   * page's cards and person panel, which show them too. */
  async function refreshOwnProfile() {
    await router.invalidate({ sync: true });
    await queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY });
  }

  async function changeProfile(input: { displayName: string; description: string }) {
    await saveProfile({ data: input });
    await refreshOwnProfile();
  }

  // The switcher and this page both read the Workspace from the loaders, so a reload shows the
  // new name or icon everywhere without a page refresh.
  async function changeWorkspaceName(name: string) {
    await saveWorkspaceName({ data: { name } });
    await router.invalidate({ sync: true });
  }

  // The page moves to the Workspace's new URL; the loaders for that URL then read it fresh.
  async function changeWorkspaceUrl(slug: string) {
    const workspace = await saveWorkspaceSlug({ data: { slug } });
    await navigate({
      to: "/w/$workspaceSlug/settings",
      params: { workspaceSlug: workspace.slug },
      search: { section: "workspace-profile" },
    });
  }

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
      memoryContent={memorySelected ? <Outlet /> : undefined}
      personalMemory={personalMemory}
      onSectionChange={selectSection}
      profile={profile}
      createdAgents={createdAgents}
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
