import {
  BellRinging01,
  Building07,
  Link03,
  Server01,
  Share01,
  Sliders01,
  Translate01,
  UserCircle,
  Users01,
} from "@untitledui/icons";

import { m } from "#src/paraglide/messages";

/**
 * The one list of Settings sections, by navigation group: the route's `section` search param, the
 * navigation, the page header and the loading placeholder all read it. Small and free of feature
 * views, because the route's search validation and pending component import it.
 */
export const SETTINGS_SECTION_GROUPS = [
  {
    label: () => m.settings_personal_group(),
    sections: [
      { id: "account", label: () => m.settings_account(), icon: UserCircle },
      { id: "language-region", label: () => m.settings_language_region(), icon: Translate01 },
      { id: "preferences", label: () => m.settings_preferences(), icon: Sliders01 },
      { id: "notifications", label: () => m.settings_notifications(), icon: BellRinging01 },
      { id: "integrations", label: () => m.settings_integrations(), icon: Share01 },
    ],
  },
  {
    label: () => m.settings_workspace_group(),
    sections: [
      { id: "workspace-profile", label: () => m.settings_workspace_profile(), icon: Building07 },
      { id: "members", label: () => m.settings_members(), icon: Users01 },
      { id: "applications", label: () => m.settings_applications(), icon: Link03 },
    ],
  },
  {
    label: () => m.settings_system_group(),
    sections: [
      { id: "server-connection", label: () => m.settings_server_connection(), icon: Server01 },
    ],
  },
] as const;

type SettingsSectionEntry = (typeof SETTINGS_SECTION_GROUPS)[number]["sections"][number];

export type SettingsSection = SettingsSectionEntry["id"];

const ENTRIES: readonly SettingsSectionEntry[] = SETTINGS_SECTION_GROUPS.flatMap(
  (group): readonly SettingsSectionEntry[] => group.sections,
);

/** Every section id, for the route's search validation (`z.enum`). */
export const SETTINGS_SECTIONS = ENTRIES.map((entry) => entry.id) as [
  SettingsSection,
  ...SettingsSection[],
];

/** One section's label and icon. */
export function settingsSection(id: SettingsSection): SettingsSectionEntry {
  return ENTRIES.find((entry) => entry.id === id)!;
}
