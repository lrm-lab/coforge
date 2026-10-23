import type { ReactNode } from "react";
import { SUBFIELD_LABEL_CLASS } from "./inline-edit-field";

/**
 * One INFO / RUNTIME CONFIG fact: a fixed-width gray label on the left, the value on the right.
 * The label width is shared by every row in both sections, so values line up in one column.
 */
export function FactRow({
  label,
  children,
  className = "",
}: {
  /** The label text, or a node such as the label plus its edit pencil. */
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-4 ${className}`}>
      <div className={`flex items-center gap-1.5 ${SUBFIELD_LABEL_CLASS}`}>{label}</div>
      <div className="min-w-0 text-sm font-medium text-primary">{children}</div>
    </div>
  );
}
