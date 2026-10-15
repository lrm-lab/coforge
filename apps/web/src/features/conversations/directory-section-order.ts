import type { DirectorySectionId } from "./directory-sections";

/** The sections every member has; custom ones are `custom:<id>`. */
export const BUILT_IN_SECTIONS = ["pinned", "channels", "agents"] as const;
export type BuiltInSection = (typeof BUILT_IN_SECTIONS)[number];

export function isBuiltInSection(key: string): key is BuiltInSection {
  return (BUILT_IN_SECTIONS as readonly string[]).includes(key);
}

/** A stored order entry: a built-in section's key, or a custom section's id. */
export function sectionIdOfKey(key: DirectorySectionId): string {
  return key.startsWith("custom:") ? key.slice("custom:".length) : key;
}

function keyOfStored(entry: string): DirectorySectionId {
  return isBuiltInSection(entry) ? entry : `custom:${entry}`;
}

/**
 * The sidebar's sections, top to bottom. With nothing saved: Pinned, the custom sections in their
 * own order, Channels, Direct messages. A saved order (built-in keys and custom ids, as the member
 * last dragged them) wins; a section it does not name (a section created since, or one this device
 * never saw) keeps its default place: after every section that precedes it by default. An entry
 * naming a section that is gone is dropped.
 */
export function directorySectionOrder(
  saved: readonly string[],
  customIds: readonly string[],
): DirectorySectionId[] {
  const defaults: DirectorySectionId[] = [
    "pinned",
    ...customIds.map((id) => `custom:${id}` as const),
    "channels",
    "agents",
  ];
  const known = new Set(defaults);
  const order: DirectorySectionId[] = [];
  for (const entry of saved) {
    const key = keyOfStored(entry);
    if (known.has(key) && !order.includes(key)) order.push(key);
  }
  defaults.forEach((key, index) => {
    if (order.includes(key)) return;
    // After every section that precedes it by default, wherever the member moved those.
    const after = Math.max(-1, ...defaults.slice(0, index).map((before) => order.indexOf(before)));
    order.splice(after + 1, 0, key);
  });
  return order;
}

/** The section keys as the server stores them: custom sections by id. */
export function storedSectionOrder(order: readonly DirectorySectionId[]): string[] {
  return order.map(sectionIdOfKey);
}
