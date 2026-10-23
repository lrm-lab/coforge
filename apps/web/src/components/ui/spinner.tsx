import type { SVGProps } from "react";
import { cx } from "#src/utils/cx";

/** The one "action in progress" indicator: a rotating three-quarter arc in the current text color. */
export function Spinner({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 32 32"
      className={cx("size-5 motion-safe:animate-spin", className)}
      {...props}
    >
      <circle
        cx="16"
        cy="16"
        r="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeDasharray="100"
        strokeDashoffset="40"
        strokeLinecap="round"
      />
    </svg>
  );
}
