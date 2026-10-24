import { SaveErrorMessage, type SaveError } from "./save-error";

/** The building blocks every Settings page lays itself out with: page, group, card, field, footer. */

export function SettingsPage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-5xl space-y-8 px-4 pt-6 pb-8 sm:px-8">{children}</div>;
}

/** A captioned group of settings; each card inside is one independent setting or save unit. */
export function SettingsGroup({
  icon: Icon,
  label,
  badge,
  children,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  /** Shown after the caption, such as how many items the group lists. */
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label}>
      <h2 className="flex items-center gap-2 pb-3 text-xs font-semibold tracking-wide text-tertiary uppercase">
        <Icon aria-hidden="true" className="size-4" />
        {label}
        {badge}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-secondary bg-primary p-5 shadow-xs sm:p-6">
      {children}
    </div>
  );
}

export function SettingsField({
  label,
  description,
  note,
  inline = false,
  children,
}: {
  label: string;
  description: string;
  /** Where the value is kept, e.g. "Saved on this device." */
  note?: string;
  /** Put the control at the end of the row (switches) instead of under the text. */
  inline?: boolean;
  children: React.ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-primary">{label}</h3>
      <p className="mt-1 text-sm text-tertiary">{description}</p>
    </div>
  );
  const noteText = note && <p className="text-xs font-medium text-tertiary">{note}</p>;

  if (inline)
    return (
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-3">
          {text}
          {noteText}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {text}
      <div className="min-w-0 max-w-xl">{children}</div>
      {noteText}
    </div>
  );
}

export function SettingsCardFooter({
  error,
  children,
}: {
  error?: SaveError | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      {error && <SaveErrorMessage error={error} />}
    </div>
  );
}
