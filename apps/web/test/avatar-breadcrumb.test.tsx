import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { AvatarPicker } from "#src/features/profiles/avatar-picker";
import { m } from "#src/paraglide/messages";
import { SettingsContent } from "#src/components/settings-content";

const crumb = (
  <nav aria-label={m.settings_breadcrumb()} className="hidden items-center gap-1 sm:flex">
    <Button type="button" color="link-gray" size="sm">
      {m.settings_account()}
    </Button>
  </nav>
);

test("PageHeader renders the earlier crumbs before its heading, which is the trail's last crumb", () => {
  const markup = renderToStaticMarkup(
    <PageHeader heading={m.settings_avatar_choose()} breadcrumb={crumb} />,
  );
  expect(markup).toContain(m.settings_account());
  expect(markup).toContain(m.settings_avatar_choose());
  // Exactly one h1, and it is the PageHeader's own text-lg heading.
  expect(markup.match(/<h1/g)).toHaveLength(1);
  expect(markup).toContain(
    `<h1 class="truncate text-lg font-semibold text-primary">${m.settings_avatar_choose()}</h1>`,
  );
});

test("PageHeader without a breadcrumb renders only its plain heading", () => {
  const markup = renderToStaticMarkup(<PageHeader heading={m.settings_account()} />);
  expect(markup).not.toContain(m.settings_breadcrumb());
  expect(markup).toContain(
    `<h1 class="truncate text-lg font-semibold text-primary">${m.settings_account()}</h1>`,
  );
});

test("AvatarPicker starts with its content; the breadcrumb moved into the page header", () => {
  const markup = renderToStaticMarkup(
    <AvatarPicker
      name="Frank"
      currentAvatarUrl={null}
      onSave={async () => {}}
      onClose={() => {}}
    />,
  );
  expect(markup).not.toContain("<nav");
  expect(markup).not.toContain(m.settings_profile());
  expect(markup).toContain(m.settings_avatar_picker_title());
});

const settingsProps = {
  githubCallbackError: false,
  githubWrongAccount: false,
  profile: {
    name: "Frank",
    displayName: "Frank",
    email: "frank@example.com",
    description: "",
    avatarUrl: null,
    joinedAt: "2026-01-01T00:00:00Z",
  },
  createdAgents: [],
  members: { actorUserId: "user-1", actorRole: "owner", members: [] },
  locale: "en" as const,
  theme: "light" as const,
  hideEmptySidebarSections: false,
  messageFullWidth: false,
  timeZone: null,
  timeFormat: null,
  browserNotificationsEnabled: false,
  browserNotificationPermission: "unsupported" as const,
  browserNotificationsConfigured: false,
  showAddToHomeScreenGuide: false,
  onProfileSave: async () => {},
  onAvatarUpload: async () => {},
  onAvatarPresetChoose: async () => {},
  onAvatarRemove: async () => {},
  avatarPicker: false,
  onAvatarPickerChange: () => {},
  onLocaleChange: () => {},
  onThemeChange: () => {},
  onMessageFullWidthChange: () => {},
  onHideEmptySidebarSectionsChange: () => {},
  onDateTimeSave: async () => {},
  conversationOpenMode: "first-unread" as const,
  onConversationOpenModeChange: () => {},
  onBrowserNotificationsChange: async () => {},
  onEnableBrowserNotifications: async () => {},
  onTestBrowserNotification: async () => false,
  generalChannelHidden: null,
  onGeneralChannelHiddenSave: async () => {},
  workspace: { id: "w-1", slug: "acme", name: "Acme", iconUrl: null },
  onWorkspaceRename: async () => {},
  onWorkspaceSlugChange: async () => {},
  onWorkspaceIconUpload: async () => {},
};

test("Settings → Account with the picker open names the header trail: Account › Change avatar", () => {
  const markup = renderToStaticMarkup(
    <SettingsContent {...settingsProps} section="account" avatarPicker />,
  );
  // The trail sits in the header, labelled as a breadcrumb, ending in the picker's row heading.
  expect(markup).toContain(`aria-label="${m.settings_breadcrumb()}"`);
  expect(markup).toContain(m.settings_account());
  expect(markup).toContain(
    `<h1 class="truncate text-lg font-semibold text-primary">${m.settings_avatar_choose()}</h1>`,
  );
  // The picker body starts with its content; no second breadcrumb in the content area.
  const body = markup.slice(markup.indexOf(m.settings_avatar_picker_title()));
  expect(body).not.toContain("<nav");
  // The settings page also owns a sidebar nav; the trail itself appears exactly once.
  expect(markup.match(new RegExp(m.settings_breadcrumb(), "g"))).toHaveLength(1);
});

test("Account without the picker keeps the plain heading and no trail", () => {
  const markup = renderToStaticMarkup(
    <SettingsContent {...settingsProps} section="account" avatarPicker={false} />,
  );
  expect(markup).toContain(
    `<h1 class="truncate text-lg font-semibold text-primary">${m.settings_account()}</h1>`,
  );
  expect(markup).not.toContain(m.settings_avatar_choose());
  expect(markup).not.toContain(m.settings_breadcrumb());
});
