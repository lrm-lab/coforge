import type { MascotId } from "./mascot-contract";

/**
 * The Rive runtime contract every mascot artboard shares: the names the browser drives a mascot
 * by and the generator writes into the file (`assets/mascots/`). Pure names and string builders.
 * Changing one is a breaking change: bump `RIV_VERSION` with it.
 */
export const MASCOT_ACTIVITIES = ["idle", "thinking", "working", "error", "offline"] as const;
export type MascotActivity = (typeof MASCOT_ACTIVITIES)[number];

export const MASCOT_RIVE = {
  stateMachine: "State Machine 1",
  viewModel: "Mascot",
  /** Enum property: one of `MASCOT_ACTIVITIES`. Default `idle`. */
  activityProperty: "activity",
  /** Boolean property: the pointer is over the mascot. Default `false`. */
  hoveredProperty: "hovered",
  /** Number properties in [-1, 1]: where the eyes look, 0 straight ahead, +x right, +y down
   * (`lookToward`). Default `0`. The file decides how far a full deflection moves the eyes. */
  lookXProperty: "lookX",
  lookYProperty: "lookY",
} as const;

/** Version of the Rive file (`mascots-<n>.riv`); bumped with the file name for the same reason as
 * `STATIC_VERSION`. */
export const RIV_VERSION = 4;

/** The one Rive file that animates every mascot. */
export function mascotRivUrl(): string {
  return `/agent-avatars/mascots-${RIV_VERSION}.riv`;
}

/** The artboard of the Rive file that draws one mascot. */
export function mascotArtboard(id: MascotId): string {
  return `mascot-${id}`;
}
