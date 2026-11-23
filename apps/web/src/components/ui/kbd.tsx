import { useHydrated } from "@tanstack/react-router";

import { hotkeyAria, hotkeyKeycaps } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { cx } from "#src/utils/cx";

export type KeycapTone = "default" | "tooltip" | "current";
export type KeycapSize = "sm" | "xs";

const KEYCAP_BASE =
  "inline-grid shrink-0 place-items-center rounded-sm px-1 font-body text-xs leading-none font-medium";

const KEYCAP_SIZE: Record<KeycapSize, string> = {
  sm: "h-5 min-w-5",
  xs: "h-4.5 min-w-4.5",
};

const KEYCAP_TONE: Record<KeycapTone, string> = {
  default: "bg-primary text-tertiary ring-1 ring-primary ring-inset",
  tooltip: "text-tooltip-supporting-text ring-1 ring-current/35 ring-inset",
  current: "ring-1 ring-current/35 ring-inset",
};

function keycapClassName({
  size = "sm",
  tone = "default",
  className,
}: {
  size?: KeycapSize;
  tone?: KeycapTone;
  className?: string;
} = {}): string {
  return cx(KEYCAP_BASE, KEYCAP_SIZE[size], KEYCAP_TONE[tone], className);
}

export function useHotkeyAria(hotkey?: string): string | undefined {
  const hydrated = useHydrated();
  if (!hotkey || !hydrated) return undefined;
  return hotkeyAria(hotkey, isApplePlatform());
}

export function Keycap({
  children,
  size = "sm",
  tone = "default",
  ariaHidden = true,
  className,
}: {
  children: string | number;
  size?: KeycapSize;
  tone?: KeycapTone;
  ariaHidden?: boolean;
  className?: string;
}) {
  return (
    <kbd
      dir="ltr"
      aria-hidden={ariaHidden || undefined}
      className={keycapClassName({ size, tone, className })}
    >
      {children}
    </kbd>
  );
}

function KeycapGroup({
  keys,
  hotkey,
  size = "sm",
  tone = "default",
  hideOnTouch = false,
  ariaHidden,
  className,
}: {
  keys: readonly string[];
  hotkey?: string;
  size?: KeycapSize;
  tone?: KeycapTone;
  hideOnTouch?: boolean;
  ariaHidden?: boolean;
  className?: string;
}) {
  if (keys.length === 0) return null;
  const capClass = keycapClassName({ size, tone });
  return (
    <kbd
      dir="ltr"
      data-hotkey={hotkey}
      aria-hidden={ariaHidden || undefined}
      className={cx(
        "inline-flex shrink-0 items-center gap-1",
        hideOnTouch && "any-pointer-coarse:hidden",
        className,
      )}
    >
      {keys.map((cap, index) => (
        <span key={`${index}:${cap}`} className={capClass}>
          {cap}
        </span>
      ))}
    </kbd>
  );
}

export function HotkeyKeycaps({
  hotkey,
  apple,
  size = "sm",
  tone = "default",
  hideOnTouch = false,
  ariaHidden,
  className,
}: {
  hotkey: string;
  apple?: boolean;
  size?: KeycapSize;
  tone?: KeycapTone;
  hideOnTouch?: boolean;
  ariaHidden?: boolean;
  className?: string;
}) {
  const hydrated = useHydrated();
  if (apple === undefined && !hydrated) return null;
  const resolvedApple = apple ?? isApplePlatform();
  return (
    <KeycapGroup
      keys={hotkeyKeycaps(hotkey, resolvedApple)}
      hotkey={hotkey}
      size={size}
      tone={tone}
      hideOnTouch={hideOnTouch}
      ariaHidden={ariaHidden}
      className={className}
    />
  );
}

export function TooltipShortcutLabel({ label, shortcut }: { label: string; shortcut?: string }) {
  if (!shortcut) return label;
  return (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      <HotkeyKeycaps hotkey={shortcut} size="xs" tone="tooltip" hideOnTouch ariaHidden />
    </span>
  );
}

export function TooltipShortcutRows({
  rows,
}: {
  rows: ReadonlyArray<{ label: string; shortcut: string }>;
}) {
  return (
    <span className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <span key={row.label} className="flex items-center justify-between gap-4">
          <span className="font-medium">{row.label}</span>
          <HotkeyKeycaps hotkey={row.shortcut} size="xs" tone="tooltip" hideOnTouch ariaHidden />
        </span>
      ))}
    </span>
  );
}
