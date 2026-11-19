export const EASE_OUT = [0, 0, 0.58, 1] as const;
export const EASE_OUT_STRONG = [0.22, 1, 0.36, 1] as const;
export const EASE_IN = [0.42, 0, 1, 1] as const;
export const EASE_IN_OUT = [0.42, 0, 0.58, 1] as const;
export const EASE_OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;

export const EASE_CSS = {
  out: "cubic-bezier(0, 0, 0.58, 1)",
  outStrong: "cubic-bezier(0.22, 1, 0.36, 1)",
  in: "cubic-bezier(0.42, 0, 1, 1)",
  inOut: "cubic-bezier(0.42, 0, 0.58, 1)",
  overshoot: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

export const DURATION_MS = {
  sm: 200,
  smOut: 150,
  md: 300,
  mdOut: 200,
  lg: 400,
  lgOut: 280,
  reduced: 150,
} as const;

export const DURATION_S = {
  sm: DURATION_MS.sm / 1000,
  smOut: DURATION_MS.smOut / 1000,
  md: DURATION_MS.md / 1000,
  mdOut: DURATION_MS.mdOut / 1000,
  lg: DURATION_MS.lg / 1000,
  lgOut: DURATION_MS.lgOut / 1000,
  reduced: DURATION_MS.reduced / 1000,
} as const;
