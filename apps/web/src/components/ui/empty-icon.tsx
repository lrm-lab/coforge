import type { CSSProperties } from "react";
import { useEffect, useId, useMemo, useRef } from "react";
import type { KubaiIconData } from "kubai-icons/duotone";
import { animate } from "kubai-icons/runtime";

import { cn } from "#src/lib/utils";

type EmptyIconStyle = CSSProperties & { "--kd-b"?: string };

export function EmptyIcon({
  icon,
  size = "page",
  muted = false,
  className,
}: {
  icon: KubaiIconData;
  size?: "page" | "card";
  muted?: boolean;
  className?: string;
}) {
  const uid = useId().replaceAll(":", "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const markup = useMemo(() => icon.markup.replaceAll("__K__", `ki-${uid}`), [icon.markup, uid]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const controller = animate(svg, icon);
    const onEnter = (event: PointerEvent) => {
      if (!event.pointerType || event.pointerType === "mouse") controller.hover(true);
    };
    const onLeave = (event: PointerEvent) => {
      if (!event.pointerType || event.pointerType === "mouse") controller.hover(false);
    };
    svg.addEventListener("pointerenter", onEnter);
    svg.addEventListener("pointerleave", onLeave);
    return () => {
      svg.removeEventListener("pointerenter", onEnter);
      svg.removeEventListener("pointerleave", onLeave);
      controller.destroy();
    };
  }, [icon]);

  const toneStyle: EmptyIconStyle = muted
    ? {
        color: "var(--color-empty-muted)",
        "--kd-b": "var(--color-empty-muted-body)",
      }
    : {
        color: "var(--color-empty-accent)",
        "--kd-b": "var(--color-empty-icon-body)",
      };

  const svg = (
    <svg
      ref={svgRef}
      aria-hidden="true"
      focusable="false"
      viewBox={icon.viewBox}
      style={toneStyle}
      className={cn("shrink-0", size === "card" ? "size-[1.375rem]" : "size-12", className)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );

  if (size === "card") {
    return (
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-secondary ring-inset"
      >
        {svg}
      </span>
    );
  }

  return svg;
}
