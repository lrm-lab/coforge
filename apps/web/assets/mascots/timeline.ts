import { fmt } from "./svg-path.ts";

export type Interp = "hold" | "linear" | "cubic";
export interface Key {
  frame: number;
  value: number;
  interp?: Interp;
}
export type Tracks = Map<string, Map<string, Key[]>>;

export const FPS = 60;

/** The one ease every keyframe and blend uses: CSS ease-in-out. */
export const EASE_IN_OUT = `<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>`;

/** Frames for a duration in seconds. */
export const sec = (s: number): number => Math.round(s * FPS);

export function newTracks(): Tracks {
  return new Map();
}

/** Keys on `prop` of object `id`; the last key of a loop should equal the first. */
export function track(tracks: Tracks, id: string, prop: string, keys: Key[]): void {
  const byProp = tracks.get(id) ?? new Map<string, Key[]>();
  byProp.set(prop, keys);
  tracks.set(id, byProp);
}

/** One key holding `value` for the whole animation. */
export const still = (value: number): Key[] => [{ frame: 0, value, interp: "hold" }];

/** Shorthand: `k(frame, value, "cubic")`. */
export const k = (frame: number, value: number, interp: Interp = "cubic"): Key => ({
  frame,
  value,
  interp,
});

function keyXml(key: Key): string {
  const v = fmt(key.value);
  if (key.interp === "cubic") {
    return (
      `<KeyFrameDouble value="${v}" frame="${key.frame}" interpolationType="cubic">` +
      `${EASE_IN_OUT}</KeyFrameDouble>`
    );
  }
  return `<KeyFrameDouble value="${v}" frame="${key.frame}" interpolationType="${key.interp ?? "hold"}"/>`;
}

export interface ColorKey {
  /** The `SolidColor` this key sets. */
  id: string;
  /** `AARRGGBB`, held for the whole animation unless `keys` animate it. */
  color: string;
  /** Colours over time, eased from each to the next. */
  keys?: { frame: number; color: string }[];
}

function colorKeysXml(c: ColorKey): string {
  const keys = c.keys ?? [{ frame: 0, color: c.color }];
  return keys
    .map((key, i) =>
      i === keys.length - 1 || !c.keys
        ? `<KeyFrameColor value="${key.color}" frame="${key.frame}" interpolationType="hold"/>`
        : `<KeyFrameColor value="${key.color}" frame="${key.frame}" interpolationType="cubic">` +
          `${EASE_IN_OUT}</KeyFrameColor>`,
    )
    .join("");
}

/** A looping `LinearAnimation`: every track in `tracks` plus a colour track for each `colors` entry. */
export function animationXml(
  name: string,
  id: string,
  duration: number,
  tracks: Tracks,
  colors: ColorKey[],
): string {
  const objects: string[] = [];
  for (const [objectId, props] of tracks) {
    const keyed = [...props]
      .map(
        ([prop, keys]) =>
          `<KeyedProperty property="${prop}">\n${keys.map(keyXml).join("\n")}\n</KeyedProperty>`,
      )
      .join("\n");
    objects.push(`<KeyedObject objectId="${objectId}">\n${keyed}\n</KeyedObject>`);
  }
  for (const c of colors) {
    objects.push(
      `<KeyedObject objectId="${c.id}"><KeyedProperty property="colorValue">` +
        `${colorKeysXml(c)}</KeyedProperty></KeyedObject>`,
    );
  }
  return `<LinearAnimation loopValue="loop" duration="${duration}" name="${name}" id="${id}">\n${objects.join("\n")}\n</LinearAnimation>`;
}
