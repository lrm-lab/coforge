export const PINNED_SECTION_OPTION = "pinned";
export const DEFAULT_SECTION_OPTION = "default";

const CUSTOM_SECTION_PREFIX = "section:";

export type SidebarSectionChoice =
  | { kind: "pinned" }
  | { kind: "default" }
  | { kind: "section"; sectionId: string };

export type SidebarSectionSummary = {
  id: string;
  name: string;
  emoji?: string | null;
  conversationIds: readonly string[];
};

export function resolveSidebarSectionKey({
  conversationId,
  pinned,
  sections,
}: {
  conversationId: string;
  pinned: boolean;
  sections: readonly SidebarSectionSummary[];
}): string {
  if (pinned) return PINNED_SECTION_OPTION;
  const match = sections.find((section) => section.conversationIds.includes(conversationId));
  return match ? `${CUSTOM_SECTION_PREFIX}${match.id}` : DEFAULT_SECTION_OPTION;
}

export function parseSidebarSectionKey(key: string): SidebarSectionChoice {
  if (key === PINNED_SECTION_OPTION) return { kind: "pinned" };
  if (key.startsWith(CUSTOM_SECTION_PREFIX)) {
    return { kind: "section", sectionId: key.slice(CUSTOM_SECTION_PREFIX.length) };
  }
  return { kind: "default" };
}

export function buildSidebarSectionOptions({
  sections,
  pinnedLabel,
  defaultLabel,
}: {
  sections: readonly Pick<SidebarSectionSummary, "id" | "name" | "emoji">[];
  pinnedLabel: string;
  defaultLabel: string;
}): Array<{ id: string; label: string }> {
  return [
    { id: PINNED_SECTION_OPTION, label: pinnedLabel },
    ...sections.map((section) => ({
      id: `${CUSTOM_SECTION_PREFIX}${section.id}`,
      label: section.emoji ? `${section.emoji} ${section.name}` : section.name,
    })),
    { id: DEFAULT_SECTION_OPTION, label: defaultLabel },
  ];
}
