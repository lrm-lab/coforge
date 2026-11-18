import { useEffect, useState } from "react";

import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

const REVEAL_AFTER_MS = 300;

export type PlaceholderRow = "field" | "area" | "line" | "card" | "tall-card";

function useRevealed() {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setRevealed(true), REVEAL_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return revealed;
}

function Bar({ className }: { className: string }) {
  return <div className={cx("rounded-md bg-tertiary motion-safe:animate-pulse", className)} />;
}

export function PlaceholderBlock({ className }: { className: string }) {
  const revealed = useRevealed();
  return (
    <div
      aria-hidden
      className={cx(
        "flex flex-col transition-opacity duration-200 ease-out",
        revealed ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <Bar className="flex-1 rounded-lg" />
    </div>
  );
}

export function FieldsPlaceholder({
  rows,
  className,
}: {
  rows: PlaceholderRow[];
  className: string;
}) {
  const revealed = useRevealed();
  const controlHeight = useDialogControlSize() === "md" ? "h-10" : "h-9";
  return (
    <div
      role="status"
      aria-label={m.agent_env_loading()}
      className={cx(
        "flex flex-col transition-opacity duration-200 ease-out",
        revealed ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {rows.map((row, index) =>
        row === "line" ? (
          <div key={index} className="flex h-5 items-center">
            <Bar className="h-3 w-3/4" />
          </div>
        ) : row === "card" || row === "tall-card" ? (
          <Bar key={index} className={row === "card" ? "h-11" : "h-16"} />
        ) : (
          <div key={index} className="flex flex-col gap-1.5">
            <div className="flex h-5 items-center">
              <Bar className="h-3 w-16" />
            </div>
            <Bar className={row === "area" ? "h-20" : controlHeight} />
          </div>
        ),
      )}
    </div>
  );
}
