export type PageDisplayMode = "panel" | "inline";

export type PageThemeTokens = Readonly<Record<string, string>>;

export const INLINE_MIN_HEIGHT_PX = 96;
export const INLINE_DEFAULT_HEIGHT_PX = 200;
export const INLINE_MAX_HEIGHT_PX = 800;

export const PAGE_THEME_TOKEN_MAP = {
  "--coforge-bg": "--color-bg-primary",
  "--coforge-surface": "--color-bg-secondary",
  "--coforge-surface-subtle": "--color-bg-tertiary",
  "--coforge-fg": "--color-text-primary",
  "--coforge-fg-secondary": "--color-text-secondary",
  "--coforge-fg-muted": "--color-text-tertiary",
  "--coforge-border": "--color-border-primary",
  "--coforge-border-subtle": "--color-border-secondary",
  "--coforge-brand": "--color-bg-brand-solid",
  "--coforge-brand-fg": "--color-text-primary_on-brand",
  "--coforge-success": "--color-fg-success-primary",
  "--coforge-warning": "--color-fg-warning-primary",
  "--coforge-error": "--color-fg-error-primary",
  "--coforge-chart-1": "--color-brand-500",
  "--coforge-chart-2": "--color-utility-blue-500",
  "--coforge-chart-3": "--color-utility-green-500",
  "--coforge-chart-4": "--color-utility-yellow-500",
  "--coforge-chart-5": "--color-utility-orange-500",
  "--coforge-chart-6": "--color-utility-pink-500",
} as const;

export function readHostThemeTokens(root?: Element): PageThemeTokens {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return {};
  const target = root ?? document.documentElement;
  const styles = getComputedStyle(target);
  const tokens: Record<string, string> = {};
  for (const [tokenName, sourceVar] of Object.entries(PAGE_THEME_TOKEN_MAP)) {
    const value = styles.getPropertyValue(sourceVar).trim();
    if (value) tokens[tokenName] = value;
  }
  return tokens;
}

export type InlineHeightState = {
  height: number;
  settled: boolean;
  hostWidth: number | null;
};

export function clampInlineFrameHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return INLINE_DEFAULT_HEIGHT_PX;
  return Math.min(INLINE_MAX_HEIGHT_PX, Math.max(INLINE_MIN_HEIGHT_PX, Math.ceil(height)));
}

export function nextInlineFrameHeight(
  state: InlineHeightState,
  reportedHeight: number,
  hostWidth: number | null,
): InlineHeightState {
  if (!Number.isFinite(reportedHeight) || reportedHeight <= 0) return state;
  const clamped = clampInlineFrameHeight(reportedHeight);
  const validWidth =
    hostWidth !== null && Number.isFinite(hostWidth) && hostWidth > 0
      ? Math.round(hostWidth)
      : null;
  const widthChanged =
    state.hostWidth !== null && validWidth !== null && Math.abs(validWidth - state.hostWidth) > 2;
  if (!state.settled || widthChanged) {
    return { height: clamped, settled: true, hostWidth: validWidth };
  }
  return {
    height: Math.max(state.height, clamped),
    settled: true,
    hostWidth: state.hostWidth ?? validWidth,
  };
}
