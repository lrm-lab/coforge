import type { ReactNode } from "react";

/**
 * The whole-page frame of the 404 and load-error pages (and the 404's loading fallback, so arriving
 * content fills it instead of shifting it): centred, clear of a phone's notch and home indicator.
 * It clips, because the large empty state's background art is wider than a phone.
 */
export function ErrorPageFrame({ children }: { children?: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center overflow-x-clip bg-primary pt-[max(1.5rem,var(--spacing-safe-top))] pr-[max(1.5rem,var(--spacing-safe-right))] pb-[max(1.5rem,var(--spacing-safe-bottom))] pl-[max(1.5rem,var(--spacing-safe-left))]">
      {children}
    </div>
  );
}
