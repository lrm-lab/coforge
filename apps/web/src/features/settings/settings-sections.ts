import {
  Beaker01,
  BellRinging01,
  BookOpen01,
  Building07,
  Keyboard01,
  Link03,
  MessageTextSquare01,
  Server01,
  Share01,
  Sliders01,
  Tag01,
  Translate01,
  UserCircle,
  Users01,
} from "@untitledui/icons";
import type { FC } from "react";

import { m } from "#src/paraglide/messages";

export const SETTINGS_SECTION_GROUPS = [
  {
    id: "personal",
    label: () => m.settings_personal_group(),
    sections: [
      { id: "account", label: () => m.settings_account(), icon: UserCircle },
      { id: "language-region", label: () => m.settings_language_region(), icon: Translate01 },
      { id: "preferences", label: () => m.settings_preferences(), icon: Sliders01 },
      { id: "shortcuts", label: () => m.settings_shortcuts(), icon: Keyboard01 },
      { id: "notifications", label: () => m.settings_notifications(), icon: BellRinging01 },
      { id: "integrations", label: () => m.settings_integrations(), icon: Share01 },
    ],
  },
  {
    id: "workspace",
    label: () => m.settings_workspace_group(),
    sections: [
      { id: "workspace-profile", label: () => m.settings_workspace_profile(), icon: Building07 },
      { id: "members", label: () => m.settings_members(), icon: Users01 },
      { id: "labels", label: () => m.settings_labels(), icon: Tag01 },
      { id: "applications", label: () => m.settings_applications(), icon: Link03 },
      { id: "team-memory", label: () => m.memory_title(), icon: BookOpen01 },
      { id: "experiments", label: () => m.settings_experiments(), icon: Beaker01 },
    ],
  },
  {
    id: "system",
    label: () => m.settings_system_group(),
    sections: [
      { id: "server-connection", label: () => m.settings_server_connection(), icon: Server01 },
    ],
  },
] as const;

export type SettingsSystemLink = {
  id: "feedback-inbox";
  to: "/w/$workspaceSlug/feedback";
  label: () => string;
  icon: FC<{ className?: string }>;
};

export function settingsSystemLinks({
  canViewFeedbackInbox = false,
}: {
  canViewFeedbackInbox?: boolean;
}): readonly SettingsSystemLink[] {
  if (!canViewFeedbackInbox) return [];
  return [
    {
      id: "feedback-inbox",
      to: "/w/$workspaceSlug/feedback",
      label: () => m.feedback_inbox_link(),
      icon: MessageTextSquare01,
    },
  ];
}

type SettingsSectionEntry = (typeof SETTINGS_SECTION_GROUPS)[number]["sections"][number];

export type SettingsSection = SettingsSectionEntry["id"];

const ENTRIES = SETTINGS_SECTION_GROUPS.flatMap(
  (group): readonly SettingsSectionEntry[] => group.sections,
);

export const SETTINGS_SECTIONS = ENTRIES.map((entry) => entry.id) as [
  SettingsSection,
  ...SettingsSection[],
];

export function settingsSection(id: SettingsSection): SettingsSectionEntry {
  return ENTRIES.find((entry) => entry.id === id)!;
}
