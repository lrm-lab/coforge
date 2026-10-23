import type { ReactNode } from "react";

/** A titled block of a settings panel, divided from the one above it. */
export function PanelSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-secondary py-5 first:border-t-0">
      <h3 className="text-md font-semibold text-primary">{title}</h3>
      {description && <p className="mt-1 text-sm text-tertiary">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** One preference: its name and what it does on the left, its control on the right. */
export function PreferenceRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="mt-0.5 text-sm text-tertiary">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
