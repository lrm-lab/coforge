import { nextId, type SharedIds } from "./contract.ts";
import { fmt } from "./svg-path.ts";

/**
 * How far a full deflection (`lookX` / `lookY` = +-1) moves things, in artboard units (the
 * artboard is 24 by 24): the eyes by up to about one unit, the whole face a fraction of that.
 */
export const LOOK_REACH = {
  eye: { x: 1, y: 0.8 },
  face: { x: 0.3, y: 0.3 },
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
