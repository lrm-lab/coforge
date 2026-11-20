import { ARTIFACTS_GUIDE_ENTRY } from "./entries/artifacts";
import { TASKS_GUIDE_ENTRY } from "./entries/tasks";
import type { FeatureGuideContext, FeatureGuideEntry, ResolvedFeatureGuide } from "./types";

export const FIRST_PARTY_GUIDE_ENTRIES: readonly FeatureGuideEntry[] = [
  TASKS_GUIDE_ENTRY,
  ARTIFACTS_GUIDE_ENTRY,
];

export function resolveFeatureGuides(
  context: FeatureGuideContext,
  entries: readonly FeatureGuideEntry[] = FIRST_PARTY_GUIDE_ENTRIES,
): ResolvedFeatureGuide[] {
  const resolved: ResolvedFeatureGuide[] = [];
  for (const entry of entries) {
    if (entry.audience !== undefined && entry.audience !== context.audience) continue;
    if (entry.isEnabled && !entry.isEnabled(context)) continue;
    const section = entry.render(context).trim();
    if (!section) continue;
    resolved.push({ id: entry.id, manualTopics: entry.manualTopics, section });
  }
  return resolved;
}
