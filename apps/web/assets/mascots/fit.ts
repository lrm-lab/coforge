import type { MascotSpec } from "./spec.ts";
import { pathExtent, type Point } from "./svg-path.ts";

/** The white sticker outline around a mascot's whole silhouette, in source (SVG) units. */
export const OUTLINE = 2;

/** The artboard is 24 by 24; every mascot is drawn at this one scale of its source, so the seven
 * read as the same size (their designer gave the bodies near-equal areas). */
const SCALE = 0.87;

/** Room kept free around the outlined silhouette, in artboard units: more above, where the hover
 * hop and the stretch go, than below, where the mascot stands. */
const MARGIN = { top: 1.8, bottom: 1.2 };
const ARTBOARD = 24;

/** Where a mascot's source drawing sits in the artboard: `artboard = scale * source + at`. */
export interface Fit {
  scale: number;
  at: Point;
}

/** The outlined silhouette's bounds in source units: the body and every accessory, plus the
 * outline's half width. */
export function silhouette(spec: MascotSpec): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const parts = [
    spec.body.d,
    ...[...spec.behind, ...spec.front].flatMap((a) => a.parts.map((p) => p.d)),
  ];
  const all = parts.map(pathExtent);
  const pad = OUTLINE / 2;
  return {
    minX: Math.min(...all.map((b) => b.minX)) - pad,
    minY: Math.min(...all.map((b) => b.minY)) - pad,
    maxX: Math.max(...all.map((b) => b.maxX)) + pad,
    maxY: Math.max(...all.map((b) => b.maxY)) + pad,
  };
}

/**
 * Centres the outlined silhouette between the side edges and between the margins, so nothing of
 * it, outline included, reaches the artboard's edge. Throws if a source drawing is too large for
 * the common scale, rather than clipping it.
 */
export function fitFor(spec: MascotSpec): Fit {
  const b = silhouette(spec);
  const width = (b.maxX - b.minX) * SCALE;
  const height = (b.maxY - b.minY) * SCALE;
  const room = ARTBOARD - MARGIN.top - MARGIN.bottom;
  if (width > ARTBOARD || height > room) {
    throw new Error(`mascot-${spec.id} does not fit its artboard at scale ${SCALE}`);
  }
  return {
    scale: SCALE,
    at: [
      (ARTBOARD - width) / 2 - b.minX * SCALE,
      MARGIN.top + (room - height) / 2 - b.minY * SCALE,
    ],
  };
}
