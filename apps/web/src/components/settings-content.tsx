import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Share01 } from "@untitledui/icons";
import { PageHeader } from "#src/components/layout/page-header";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { WorkspaceMembersPanel } from "#src/features/workspaces/workspace-members-panel";
import {
  canChangeWorkspaceSlug,
  canManageWorkspaceSettings,
} from "#src/features/workspaces/workspace-roles";
import { GitHubSettings } from "#src/features/integrations/github-settings";
import type { GitHubCallbackFailure } from "#src/features/integrations/github-callback";
import { AppsSettings } from "#src/features/apps/apps-settings";
import { ServerConnectionSettings } from "#src/features/settings/server-connection-settings";
import { SettingsNavigationGroup } from "#src/features/settings/settings-navigation-group";
import {
  SETTINGS_SECTION_GROUPS,
  settingsSection,
  type SettingsSection,
} from "#src/features/settings/settings-sections";
import { type TimeFormat } from "#src/lib/time-format";
import { cn } from "#src/lib/utils";
import { SettingsCardFooter, SettingsField } from "#src/components/settings-layout";
import { saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";
import { AccountSettings, type AccountProfile } from "./settings-account";
import { PreferencesSettings } from "./settings-preferences";
import { WorkspaceProfileSettings } from "./settings-workspace-profile";
import { LanguageRegionSettings } from "./settings-language-region";

export type Locale = "en" | "zh-CN";
type Theme = "system" | "light" | "dark";

export interface SettingsContentProps {
  /** Controlled section; falls back to internal state when omitted (tests, previews). */
  section?: SettingsSection;
  githubCallbackFailure?: GitHubCallbackFailure;
  onSectionChange?: (section: SettingsSection) => void;
  profile: AccountProfile;
  /** The Agents the person created in this Workspace, for the profile. */
  createdAgents: Array<{ id: string; name: string; avatarUrl: string | null }>;
  members: {
    actorUserId: string;
    actorRole: string;
    members: Array<{
      userId: string;
      role: string;
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
    }>;
  };
  locale: Locale;
  theme: Theme;
  hideEmptySidebarSections: boolean;
  messageFullWidth: boolean;
  timeZone: string | null;
  timeFormat: TimeFormat | null;
  browserNotificationsEnabled: boolean;
  browserNotificationPermission: NotificationPermission | "unsupported";
  browserNotificationsConfigured: boolean;
  showAddToHomeScreenGuide: boolean;
  onProfileSave: (profile: { displayName: string; description: string }) => Promise<void>;
  onAvatarUpload: (file: File) => Promise<void>;
  onAvatarPresetChoose: (presetId: string) => Promise<void>;
  onAvatarRemove: () => Promise<void>;
  /** Whether Settings → Account shows the platform avatar picker instead of the profile. */
  avatarPicker: boolean;
  onAvatarPickerChange: (open: boolean) => void;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: Theme) => void;
  onMessageFullWidthChange: (full: boolean) => void;
  onHideEmptySidebarSectionsChange: (hide: boolean) => void;
  onDateTimeSave: (input: {
    timeZone: string | null;
    timeFormat: TimeFormat | null;
  }) => Promise<void>;
  onBrowserNotificationsChange: (enabled: boolean) => Promise<void>;
  onEnableBrowserNotifications: () => Promise<void>;
  onTestBrowserNotification: () => Promise<boolean>;
  /** Whether #general is hidden from the Workspace; `null` unless the viewer is an owner or admin,
   * who alone see the System channels section of Settings → Members. */
  generalChannelHidden: boolean | null;
  onGeneralChannelHiddenSave: (hidden: boolean) => Promise<void>;
  /** The Workspace the page URL names. */
  workspace: { id: string; slug: string; name: string; iconUrl: string | null };
  onWorkspaceRename: (name: string) => Promise<void>;
  /** Changes the Workspace URL; resolves once the page has moved to the new URL. */
  onWorkspaceSlugChange: (slug: string) => Promise<void>;
  onWorkspaceIconUpload: (file: File) => Promise<void>;
  /** The archived channels and Agents groups Settings → Workspace profile shows under the profile. */
  archivedGroups?: React.ReactNode;
  /** The Danger zone Settings → Workspace profile ends with. */
  dangerZone?: React.ReactNode;
}

export function SettingsContent(props: SettingsContentProps) {
  const [internalSection, setInternalSection] = useState<SettingsSection>("account");
  const section = props.section ?? internalSection;
  const [showList, setShowList] = useState(props.section !== "integrations");
  const current = settingsSection(section);
  const sectionLabel = current.label();

  function selectSection(next: SettingsSection) {
    setInternalSection(next);
    props.onSectionChange?.(next);
    setShowList(false);
  }

  return (
    <main data-panel-cards className="flex h-full min-w-0 bg-primary lg:gap-2 lg:bg-transparent">
      <nav
        aria-label={m.settings_title()}
        className={cn(
          "min-w-0 flex-col overflow-hidden border-secondary bg-primary md:flex md:w-60 md:shrink-0 md:border-r lg:rounded-xl lg:border-r-0",
          showList ? "flex w-full" : "hidden",
        )}
      >
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          {SETTINGS_SECTION_GROUPS.map((group) => (
            <SettingsNavigationGroup key={group.label()} label={group.label()}>
              {group.sections.map((item) => (
                <SettingsNavigationButton
                  key={item.id}
                  active={section === item.id}
                  icon={item.icon}
                  label={item.label()}
                  onClick={() => selectSection(item.id)}
                />
              ))}
            </SettingsNavigationGroup>
          ))}
        </div>
      </nav>
      <section
        className={cn(
          "@container/settings min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex lg:rounded-xl",
          showList ? "hidden" : "flex",
        )}
      >
        <div>
          <PageHeader
            icon={current.icon}
            heading={
              section === "account" && props.avatarPicker
                ? m.settings_avatar_choose()
                : sectionLabel
            }
            breadcrumb={
              section === "account" && props.avatarPicker ? (
                /* Settings → Account › Change avatar: the Account crumb is the only one before
                   the heading, so narrow screens drop the whole nav (project-tree's pattern). */
                <nav
                  aria-label={m.settings_breadcrumb()}
                  className="hidden min-w-0 items-center gap-1 text-sm text-tertiary sm:flex"
                >
                  <Button
                    type="button"
                    color="link-gray"
                    size="sm"
                    onPress={() => props.onAvatarPickerChange(false)}
                  >
                    {sectionLabel}
                  </Button>
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-quaternary" />
                </nav>
              ) : undefined
            }
            leading={
              <ButtonUtility
                icon={ChevronLeft}
                color="tertiary"
                size="sm"
                className="-ml-2 size-11 md:hidden"
                tooltip={m.settings_title()}
                onClick={() => setShowList(true)}
              />
            }
          />
        </div>

        <section aria-label={sectionLabel} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {section === "account" ? (
              <AccountSettings {...props} />
            ) : section === "language-region" ? (
              <LanguageRegionSettings {...props} />
            ) : section === "workspace-profile" ? (
              <WorkspaceProfileSettings
                // A rename lands through the loader; a fresh Workspace starts a fresh form.
                key={props.workspace.id}
                workspace={props.workspace}
                canEdit={canManageWorkspaceSettings(props.members.actorRole)}
                onRename={props.onWorkspaceRename}
                canChangeSlug={canChangeWorkspaceSlug(props.members.actorRole)}
                onSlugChange={props.onWorkspaceSlugChange}
                onIconUpload={props.onWorkspaceIconUpload}
                archivedGroups={props.archivedGroups}
                dangerZone={props.dangerZone}
              />
            ) : section === "members" ? (
              <WorkspaceMembersPanel
                actorUserId={props.members.actorUserId}
                actorRole={props.members.actorRole}
                members={props.members.members}
                systemChannels={
                  // Workspace-wide channel settings: present only for a Workspace owner or admin.
                  props.generalChannelHidden !== null && (
                    <SystemChannelsSettings
                      hidden={props.generalChannelHidden}
                      onSave={props.onGeneralChannelHiddenSave}
                    />
                  )
                }
              />
            ) : section === "applications" ? (
              <AppsSettings actorRole={props.members.actorRole} />
            ) : section === "preferences" ? (
              <PreferencesSettings {...props} />
            ) : section === "server-connection" ? (
              <ServerConnectionSettings />
            ) : section === "integrations" ? (
              <GitHubSettings callbackFailure={props.githubCallbackFailure} />
            ) : (
              <NotificationSettings {...props} />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function SettingsNavigationButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.FC<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <Button
        type="button"
        color="tertiary"
        iconLeading={icon}
        aria-current={active ? "page" : undefined}
        onPress={onClick}
        className={cn(
          "h-9 w-full min-w-0 justify-start rounded-lg px-3 text-sm font-medium",
          active && "bg-active text-brand-secondary",
        )}
      >
        <span className="truncate">{label}</span>
      </Button>
    </li>
  );
}

/** Settings → Members → System channels: hiding #general from the whole Workspace, the only way
 * back once it is hidden. A checkbox and Save, so hiding it for everyone is a deliberate step. */
function SystemChannelsSettings({
  hidden,
  onSave,
}: {
  hidden: boolean;
  onSave: (hidden: boolean) => Promise<void>;
}) {
  const headingId = useId();
  const [draft, setDraft] = useState(hidden);
  const [saving, guard] = useSubmitGuard();
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  useEffect(() => setDraft(hidden), [hidden]);

  function save() {
    void guard(async () => {
      setSaveError(null);
      try {
        await onSave(draft);
      } catch (cause) {
        setSaveError(saveErrorFrom(m.settings_save_error(), cause));
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 py-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {m.settings_system_channels()}
      </h2>
      <SettingsField
        inline
        label={m.settings_system_channels_hide_general()}
        description={m.settings_system_channels_hide_general_description()}
      >
        <Checkbox
          size="md"
          aria-label={m.settings_system_channels_hide_general()}
          isSelected={draft}
          isDisabled={saving}
          onChange={setDraft}
        />
      </SettingsField>
      <SettingsCardFooter error={saveError}>
        <Button type="button" size="sm" isDisabled={saving || draft === hidden} onPress={save}>
          {saving ? m.settings_group_saving() : m.settings_group_save()}
        </Button>
      </SettingsCardFooter>
    </section>
  );
}

function NotificationSettings({
  browserNotificationsEnabled,
  browserNotificationPermission,
  browserNotificationsConfigured,
  showAddToHomeScreenGuide,
  onBrowserNotificationsChange,
  onEnableBrowserNotifications,
  onTestBrowserNotification,
}: SettingsContentProps) {
  const [saving, guardSave] = useSubmitGuard();
  const [testing, guardTest] = useSubmitGuard();
  const [testSent, setTestSent] = useState(false);
  const unavailableReason = !browserNotificationsConfigured
    ? m.notifications_push_unconfigured()
    : browserNotificationPermission === "unsupported"
      ? m.preferences_browser_notifications_unsupported()
      : browserNotificationPermission === "denied"
        ? m.preferences_browser_notifications_blocked()
        : null;
  const toggleDisabled =
    saving || !browserNotificationsConfigured || browserNotificationPermission === "unsupported";
  const showActions = browserNotificationsEnabled && browserNotificationsConfigured;

  return (
    <div className="w-full px-page pb-8">
      <div className="divide-y divide-secondary border-b border-secondary">
        <div className="py-2">
          <div className="flex min-h-14 items-center justify-between gap-5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">{m.notifications_push_title()}</h2>
              <p className="mt-0.5 text-sm text-tertiary">
                {unavailableReason ?? m.notifications_push_description()}
              </p>
            </div>
            <Toggle
              size="md"
              className="shrink-0"
              aria-label={m.preferences_browser_notifications()}
              isSelected={browserNotificationsEnabled}
              isDisabled={toggleDisabled}
              onChange={(isSelected) => {
                setTestSent(false);
                void guardSave(() => onBrowserNotificationsChange(isSelected));
              }}
            />
          </div>
          {showActions && (
            <div className="flex flex-wrap items-center gap-3 pb-3">
              {browserNotificationPermission === "default" && (
                <Button
                  type="button"
                  color="secondary"
                  size="sm"
                  isDisabled={saving}
                  onPress={() => void guardSave(() => onEnableBrowserNotifications())}
                >
                  {m.preferences_browser_notifications_allow_browser()}
                </Button>
              )}
              <Button
                type="button"
                color="secondary"
                size="sm"
                isDisabled={browserNotificationPermission !== "granted" || testing}
                onPress={() => {
                  setTestSent(false);
                  void guardTest(async () => setTestSent(await onTestBrowserNotification()));
                }}
              >
                {testing
                  ? m.preferences_browser_notifications_testing()
                  : m.preferences_browser_notifications_test()}
              </Button>
              {testSent && (
                <span role="status" className="text-xs text-tertiary">
                  {m.preferences_browser_notifications_test_sent()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {showAddToHomeScreenGuide && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-secondary bg-secondary px-4 py-4">
          <Share01 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-tertiary" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-primary">
              {m.notifications_home_screen_title()}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-tertiary">
              {m.notifications_home_screen_description()}
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-secondary">
              <li>{m.notifications_home_screen_share()}</li>
              <li>{m.notifications_home_screen_add()}</li>
              <li>{m.notifications_home_screen_open()}</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
