export interface ComponentMisuse {
  readonly when: string;
  readonly why: string;
  readonly instead: string;
}

export interface ComponentTimingSpec {
  readonly openDelayMs?: number;
  readonly closeDelayMs?: number;
  readonly cooldownMs?: number;
  readonly swapSlowMs?: number;
  readonly pointerSpeedWindowMs?: number;
  readonly pointerFastThresholdPxPerMs?: number;
  readonly showDelayMs?: number;
  readonly minVisibleMs?: number;
  readonly statusDurationMs?: number;
  readonly actionDurationMs?: number;
}

export interface ComponentMotionSpec {
  readonly enterMs?: number;
  readonly exitMs?: number;
  readonly swapMs?: number;
  readonly spring?: string;
  readonly transform?: string;
  readonly reducedMotion: "fade-only" | "instant" | "static" | "insertion-line-only";
}

export type ComponentCategory =
  | "overlay"
  | "dialog"
  | "feedback"
  | "motion"
  | "state"
  | "navigation"
  | "control";

export interface ComponentMeta {
  readonly component: string;
  readonly category?: ComponentCategory;
  readonly overlayKind?: "label" | "card" | "preview" | "click-menu";
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly ComponentMisuse[];
  readonly timing?: ComponentTimingSpec;
  readonly motion?: ComponentMotionSpec;
  readonly accessibility?: readonly string[];
  readonly limits?: Readonly<Record<string, number | boolean | string>>;
}
