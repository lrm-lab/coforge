import { useRef, useState, type PointerEvent, type ReactNode } from "react";

import { cn } from "#src/lib/utils";

const CLOSE_DRAG_PX = 90;

export function ArtifactSidePanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const press = (event: PointerEvent<HTMLDivElement>) => {
    start.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current !== null) setDrag(Math.max(0, event.clientY - start.current));
  };
  const release = () => {
    if (start.current === null) return;
    const dragged = drag;
    start.current = null;
    setDrag(0);
    if (dragged > CLOSE_DRAG_PX) onClose();
  };
  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-30 bg-overlay/40 sm:hidden"
        onClick={onClose}
      />
      <aside
        aria-label={label}
        style={drag > 0 ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        className={cn(
          "flex w-[340px] shrink-0 flex-col border-l border-secondary bg-primary max-sm:motion-safe:transition-transform max-sm:motion-safe:motion-leave-lg",
          "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:h-[75dvh] max-sm:w-auto max-sm:rounded-t-2xl max-sm:border-t max-sm:border-l-0 max-sm:shadow-xl",
        )}
      >
        <div
          aria-hidden="true"
          className="flex h-5 shrink-0 cursor-grab touch-none items-center justify-center sm:hidden"
          onPointerDown={press}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
        >
          <span className="h-1 w-10 rounded-full bg-quaternary" />
        </div>
        {children}
      </aside>
    </>
  );
}
