import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SafeZoneTriangle } from "#src/lib/cascade-menu-safe-zone";

export type CascadeDebugTimerKind = "open" | "drag-open" | "safe-window" | "close";

export interface CascadeDebugTimer {
  readonly kind: CascadeDebugTimerKind;
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface CascadeDebugZoneEntry {
  readonly depth: number;
  readonly zone: SafeZoneTriangle;
  readonly parentTop: number;
  readonly parentBottom: number;
}

export interface CascadeMenuDebugOverlayProps {
  readonly zones: readonly CascadeDebugZoneEntry[];
  readonly timer: CascadeDebugTimer | null;
  readonly openPathKey: string;
}

export function CascadeMenuDebugOverlay({
  zones,
  timer,
  openPathKey,
}: CascadeMenuDebugOverlayProps) {
  const [now, setNow] = useState(() => performance.now());
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    if (el.matches(":popover-open")) {
      el.hidePopover();
    }
    el.showPopover();
    return () => {
      if (el.isConnected && el.matches(":popover-open")) {
        el.hidePopover();
      }
    };
  }, [openPathKey]);

  useEffect(() => {
    if (!timer) return;
    let rafId = 0;
    const tick = () => {
      setNow(performance.now());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [timer]);

  if (typeof document === "undefined") return null;

  const elapsedMs = timer
    ? Math.min(timer.durationMs, Math.max(0, Math.round(now - timer.startedAt)))
    : 0;

  return createPortal(
    /* Safari 26+ freezes status-bar sampling over transparent fixed full-screen layers. */
    <div
      ref={overlayRef}
      popover="manual"
      aria-hidden="true"
      className="cascade-menu-debug-overlay pointer-events-none invisible fixed inset-0 m-0 size-full border-0 bg-transparent p-0"
      data-cascade-debug-overlay="true"
    >
      <svg className="visible size-full overflow-visible">
        {zones.map(({ depth, zone, parentTop, parentBottom }) => {
          const points = `${zone.apex.x},${zone.apex.y} ${zone.edgeTop.x},${zone.edgeTop.y} ${zone.edgeBottom.x},${zone.edgeBottom.y}`;
          return (
            <g key={depth}>
              <rect
                x={zone.bandStart}
                y={parentTop}
                width={Math.max(0, zone.bandEnd - zone.bandStart)}
                height={Math.max(0, parentBottom - parentTop)}
                fill="rgba(59, 130, 246, 0.05)"
                stroke="rgba(59, 130, 246, 0.35)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <polygon
                points={points}
                fill="rgba(59, 130, 246, 0.16)"
                stroke="rgba(59, 130, 246, 0.85)"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
              <circle cx={zone.apex.x} cy={zone.apex.y} r="3" fill="rgba(59, 130, 246, 0.9)" />
            </g>
          );
        })}
      </svg>
      <div className="visible fixed right-3 bottom-3 rounded-md border border-blue-500/40 bg-neutral-950/85 px-2.5 py-1 font-mono text-xs text-blue-100 tabular-nums shadow-md backdrop-blur-sm">
        {timer ? `${timer.kind}: ${elapsedMs}ms / ${timer.durationMs}ms` : "cascade: idle"}
      </div>
    </div>,
    document.body,
  );
}
