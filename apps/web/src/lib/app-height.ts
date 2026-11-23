export type AppHeightReading = {
  measured: number;
  fixedViewportHeight: number;
  installed: boolean;
  safeAreaTotal: number;
  onScreenKeyboardMayBeUp: boolean;
  applied: number | undefined;
  tallestSeen: number | undefined;
};

export function appHeight(reading: AppHeightReading): number {
  const { measured, installed, safeAreaTotal, onScreenKeyboardMayBeUp, applied, tallestSeen } =
    reading;
  if (!installed) return measured;
  if (onScreenKeyboardMayBeUp && applied !== undefined && measured < applied) return applied;
  if (tallestSeen === undefined) return measured;
  if (tallestSeen - measured <= safeAreaTotal) return measured;
  return Math.max(measured, Math.min(tallestSeen, reading.fixedViewportHeight));
}

export function viewportShapeKey(landscape: boolean, screenWidth: number): string {
  return `${landscape ? "landscape" : "portrait"}:${screenWidth}`;
}

export function tallestHeightSeen(previous: number | undefined, measured: number): number {
  return Math.max(previous ?? 0, measured);
}
