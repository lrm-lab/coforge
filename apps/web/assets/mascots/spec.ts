import { join } from "node:path";
import type { MascotId } from "#src/features/agents/mascot-contract";
import { pathBounds, type Point } from "./svg-path.ts";
import { drawnElements, type SvgElement } from "./svg-source.ts";

/**
 * Paints are listed bottom to top: a later paint draws over an earlier one. (Parts are the
 * opposite: a part list reads front to back, like sibling nodes in RML.)
 */
export interface Paint {
  fill?: string;
  stroke?: { color: string; width: number; cap?: "round" | "butt"; join?: "round" | "miter" };
}
export interface Part {
  d: string;
  paints: Paint[];
}

/** A part of the picture that the hover reaction moves on its own (hat, headphones, sparkle). */
export interface Accessory {
  name: string;
  parts: Part[];
  /** Pivot, in SVG coordinates, the hover wiggle or pulse turns around. */
  pivot: Point;
  hover: { wiggle: number; pulse: number };
}

export interface Glint {
  offset: Point;
  width: number;
  height: number;
  rotation: number;
}

export interface MascotSpec {
  id: MascotId;
  body: { d: string; fill: string };
  /** Drawn under the body. */
  behind: Accessory[];
  /** Drawn over the body, under the face. */
  front: Accessory[];
  eyes: { l: Point; r: Point; radius: number; color: string; glints: Glint[] };
  /** The mascot's own mouth, shown while idle. */
  mouth: Part[];
  mouthLineColor: string;
  /** Colour of closed eyes. */
  featureColor: string;
  browColor: string;
  dots: { points: Point[]; color: string };
}

const DIR = join(import.meta.dir, "svg");
const DARK = "#101319";
const LIGHT = "#F9FBFF";

const fillPart = (e: SvgElement, fill = e.attrs.fill ?? DARK): Part => ({
  d: e.attrs.d ?? "",
  paints: [{ fill }],
});
const strokePart = (e: SvgElement): Part => ({
  d: e.attrs.d ?? "",
  paints: [
    {
      stroke: {
        color: e.attrs.stroke ?? DARK,
        width: Number(e.attrs["stroke-width"] ?? 0.8),
        cap: e.attrs["stroke-linecap"] === "round" ? "round" : "butt",
        join: e.attrs["stroke-linejoin"] === "round" ? "round" : "miter",
      },
    },
  ],
});

function centre(d: string): Point {
  const b = pathBounds(d);
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

const GREEN_GLINTS: Glint[] = [
  { offset: [0.347, -0.463], width: 0.462, height: 0.693, rotation: 0 },
  { offset: [-0.249, 0.3], width: 0.462, height: 0.819, rotation: -1.0 },
];

/** Element indexes below are positions in `drawnElements(svg)`; see svg-source.ts. */
export function loadSpec(id: MascotId): MascotSpec {
  const el = drawnElements(join(DIR, `mascot-${id}.svg`));
  const at = (i: number): SvgElement => {
    const e = el[i];
    if (!e) throw new Error(`mascot-${id}.svg has no drawn element ${i}`);
    return e;
  };
  const base: Pick<
    MascotSpec,
    "id" | "behind" | "front" | "mouthLineColor" | "featureColor" | "browColor"
  > = {
    id,
    behind: [],
    front: [],
    mouthLineColor: DARK,
    featureColor: DARK,
    browColor: DARK,
  };
  switch (id) {
    case "black":
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: DARK },
        eyes: { l: [12, 10.5], r: [15.5, 9.6], radius: 1, color: LIGHT, glints: [] },
        mouth: [strokePart(at(6))],
        mouthLineColor: LIGHT,
        featureColor: LIGHT,
        browColor: LIGHT,
        dots: {
          points: [
            [15.6, 2.0],
            [18.0, 2.4],
            [20.4, 3.4],
          ],
          color: "#7C8493",
        },
      };
    case "purple":
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: "#BB8EFF" },
        eyes: { l: [12, 10.5], r: [15.5, 9.6], radius: 1, color: DARK, glints: [] },
        mouth: [strokePart(at(4))],
        dots: {
          points: [
            [15.6, 2.0],
            [18.0, 2.4],
            [20.4, 3.4],
          ],
          color: "#8E5BE0",
        },
      };
    case "green": {
      const sparkle = (i: number, name: string): Accessory => ({
        name,
        parts: [fillPart(at(i))],
        pivot: centre(at(i).attrs.d ?? ""),
        hover: { wiggle: 0, pulse: 0.3 },
      });
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: "#62E28F" },
        front: [sparkle(9, "Sparkle left"), sparkle(10, "Sparkle top")],
        eyes: {
          l: [14.104, 10.04],
          r: [17.571, 9.346],
          radius: 1.04,
          color: DARK,
          glints: GREEN_GLINTS,
        },
        mouth: [strokePart(at(8))],
        dots: {
          points: [
            [13.2, 1.6],
            [15.6, 1.9],
            [18.0, 2.7],
          ],
          color: "#2DB868",
        },
      };
    }
    case "yellow":
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: "#F8E723" },
        front: [
          {
            name: "Headphones",
            parts: [fillPart(at(5)), fillPart(at(6)), fillPart(at(7))].reverse(),
            pivot: [6, 12],
            hover: { wiggle: 0.07, pulse: 0 },
          },
        ],
        eyes: { l: [13.4, 9.9], r: [17.9, 9.0], radius: 1, color: DARK, glints: [] },
        mouth: [fillPart(at(3))],
        dots: {
          points: [
            [15.6, 2.0],
            [18.0, 2.4],
            [20.4, 3.4],
          ],
          color: "#E58312",
        },
      };
    case "blue":
      return {
        ...base,
        body: { d: at(2).attrs.d ?? "", fill: "#67BAFF" },
        behind: [
          {
            name: "Hat",
            parts: [fillPart(at(1))],
            pivot: [8.5, 8.5],
            hover: { wiggle: 0.08, pulse: 0 },
          },
        ],
        eyes: { l: [13.2, 10.3], r: [17.2, 9.0], radius: 1, color: DARK, glints: [] },
        mouth: [strokePart(at(3))],
        dots: {
          points: [
            [15.6, 2.0],
            [18.0, 2.4],
            [20.4, 3.4],
          ],
          color: "#3C93E8",
        },
      };
    case "orange":
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: "#FFA844" },
        eyes: { l: [11.9, 9.3], r: [15.7, 7.8], radius: 1, color: DARK, glints: [] },
        mouth: [
          // The source clips this white band to the mouth with a mask; inset it so no mask is needed.
          { d: "M10.7 11.5L17.25 10.25L17.33 11.24L11.54 12.4Z", paints: [{ fill: "#FFFFFF" }] },
          fillPart(at(2), DARK),
        ],
        dots: {
          points: [
            [15.6, 2.0],
            [18.0, 2.4],
            [20.4, 3.4],
          ],
          color: "#E5701A",
        },
      };
    case "pink":
      return {
        ...base,
        body: { d: at(1).attrs.d ?? "", fill: "#FF6886" },
        front: [
          {
            name: "Sunglasses",
            parts: [fillPart(at(2)), fillPart(at(3))],
            pivot: [13, 5],
            hover: { wiggle: 0.04, pulse: 0 },
          },
        ],
        eyes: { l: [13.15, 10.4], r: [16.85, 9.4], radius: 1, color: DARK, glints: [] },
        mouth: [
          strokePart(at(8)),
          strokePart(at(7)),
          {
            d: at(6).attrs.d ?? "",
            paints: [{ fill: "#FFFFFF" }, strokePart(at(6)).paints[0] as Paint],
          },
        ],
        browColor: "#FFFFFF",
        dots: {
          points: [
            [2.4, 1.8],
            [4.8, 1.5],
            [7.2, 1.9],
          ],
          color: "#E03A63",
        },
      };
  }
}
