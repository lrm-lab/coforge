import { MASCOT_ACTIVITIES, type MascotActivity } from "#src/features/agents/mascot-rive-contract";

// The names the app drives a mascot by (ids, activities, view model, versions, URLs) are defined
// once in `src/features/agents/mascot-contract.ts` and `mascot-rive-contract.ts`; this module holds
// only what the generator needs on top: Rive object ids.

let counter = 100;
/** Document-wide unique object id, in RML's `client:object` form. */
export function nextId(): string {
  counter += 1;
  return `0:${counter}`;
}

/** A fresh object id for each activity. */
export function idPerActivity(): Record<MascotActivity, string> {
  return Object.fromEntries(MASCOT_ACTIVITIES.map((activity) => [activity, nextId()])) as Record<
    MascotActivity,
    string
  >;
}

/** Ids of the shared view model, allocated once so every artboard binds the same ones. */
export interface SharedIds {
  viewModel: string;
  instance: string;
  activityProp: string;
  hoveredProp: string;
  activityEnum: string;
  activityValue: Record<MascotActivity, string>;
}

export function allocateSharedIds(): SharedIds {
  return {
    viewModel: nextId(),
    instance: nextId(),
    activityProp: nextId(),
    hoveredProp: nextId(),
    activityEnum: nextId(),
    activityValue: idPerActivity(),
  };
}
