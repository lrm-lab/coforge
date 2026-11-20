import { chatSectionSortModes, type ChatSectionSortMode } from "./chat-section.schemas";

const DIRECTORY_SECTION_IDS = ["pinned", "channels", "agents"] as const;
export type BuiltInSectionId = (typeof DIRECTORY_SECTION_IDS)[number];
export type DirectorySectionId = BuiltInSectionId | `custom:${string}`;

const COLLAPSIBLE_SECTION_IDS = ["channels", "agents"] as const;
export type CollapsibleSectionId = (typeof COLLAPSIBLE_SECTION_IDS)[number];

export const naturalSectionSortModes = ["recent", "alpha"] as const;
export type NaturalSectionSortMode = (typeof naturalSectionSortModes)[number];

export type BuiltInSectionSortModes = {
  pinned: ChatSectionSortMode;
  channels: NaturalSectionSortMode;
  agents: NaturalSectionSortMode;
};

export const DEFAULT_BUILT_IN_SORT_MODES: BuiltInSectionSortModes = {
  pinned: "manual",
  channels: "alpha",
  agents: "recent",
};

const STORAGE_KEY = "coforge-chat-sections-collapsed";
const SORT_STORAGE_KEY = "coforge-chat-sections-sort";

export function readCollapsedSections(): CollapsibleSectionId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is CollapsibleSectionId => COLLAPSIBLE_SECTION_IDS.includes(id));
  } catch {
    return [];
  }
}

export function writeCollapsedSections(ids: CollapsibleSectionId[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

function parseMode<Mode extends string>(
  value: unknown,
  allowed: readonly Mode[],
  fallback: Mode,
): Mode {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as Mode)
    : fallback;
}

export function readBuiltInSectionSortModes(): BuiltInSectionSortModes {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BUILT_IN_SORT_MODES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { ...DEFAULT_BUILT_IN_SORT_MODES };
    const record = parsed as Record<string, unknown>;
    return {
      pinned: parseMode(record.pinned, chatSectionSortModes, DEFAULT_BUILT_IN_SORT_MODES.pinned),
      channels: parseMode(
        record.channels,
        naturalSectionSortModes,
        DEFAULT_BUILT_IN_SORT_MODES.channels,
      ),
      agents: parseMode(record.agents, naturalSectionSortModes, DEFAULT_BUILT_IN_SORT_MODES.agents),
    };
  } catch {
    return { ...DEFAULT_BUILT_IN_SORT_MODES };
  }
}

export function writeBuiltInSectionSortModes(modes: BuiltInSectionSortModes) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(modes));
  } catch {}
}

export function directorySectionHideable({
  itemCount,
  dragging,
  revealWhileDragging = false,
}: {
  itemCount: number;
  dragging: boolean;
  revealWhileDragging?: boolean;
}): boolean {
  return itemCount === 0 && !(dragging && revealWhileDragging);
}
