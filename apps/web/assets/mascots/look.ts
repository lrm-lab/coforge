import { nextId, type SharedIds } from "./contract.ts";
import { fmt } from "./svg-path.ts";

/**
 * How far a full deflection (`lookX` / `lookY` = +-1) moves things, in source units (the mascot is
 * drawn at 0.87 of them). A gentle glance: the eyes ride on the face, so together they move about
 * 0.8 artboard units across and 0.5 up and down, enough to read at 24 px and never pinned to a
 * corner; the brows (also on the face) a little less than the eyes; the whole face a fraction.
 */
export const LOOK_REACH = {
  eye: { x: 0.65, y: 0.4 },
  brow: { x: 0.4, y: 0.28 },
  face: { x: 0.25, y: 0.16 },
} as const;

/** The time a look takes to settle after the app writes a new one, seconds. */
const LOOK_SMOOTHING_S = 0.2;

/** `Node.x` / `Node.y`. */
const NODE_X = 13;
const NODE_Y = 14;

export interface LookBinds {
  /** `DataBindContext` children for the node, to place inside its element. */
  binds: string;
  /** Root elements the binds name. */
  converters: string[];
}

/**
 * Binds a node's x and y to `lookX` / `lookY`, smoothed and scaled to `reach`. Each bind owns its
 * converters: a smoothing converter carries the state of the value it eases, so none is shared.
 */
export function lookBinds(shared: SharedIds, reach: { x: number; y: number }): LookBinds {
  const converters: string[] = [];
  const axis = (prop: string, key: number, half: number): string => {
    const smooth = nextId();
    const scale = nextId();
    const group = nextId();
    converters.push(
      `<DataConverterInterpolator duration="${LOOK_SMOOTHING_S}" name="Look smoothing" id="${smooth}"/>`,
      `<DataConverterRangeMapper minInput="-1" maxInput="1" minOutput="${fmt(-half)}" maxOutput="${fmt(half)}" clampLower="true" clampUpper="true" name="Look reach" id="${scale}"/>`,
      `<DataConverterGroup name="Look" id="${group}"><DataConverterGroupItem converterId="${smooth}"/><DataConverterGroupItem converterId="${scale}"/></DataConverterGroup>`,
    );
    return `<DataBindContext sourcePathIds="${shared.viewModel}-${prop}" propertyKey="${key}" converterId="${group}"/>`;
  };
  return {
    binds: `${axis(shared.lookXProp, NODE_X, reach.x)}\n${axis(shared.lookYProp, NODE_Y, reach.y)}`,
    converters,
  };
}
