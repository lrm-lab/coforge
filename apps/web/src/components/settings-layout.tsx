import { SaveErrorMessage, type SaveError } from "./save-error";

export function SettingsPage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-5xl space-y-8 px-page pt-6 pb-8">{children}</div>;
}

export function SettingsGroup({
  icon: Icon,
  label,
  badge,
  children,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label}>
      <h2 className="flex items-center gap-2 pb-3 text-xs font-semibold text-tertiary">
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
    <div className="flex flex-col gap-6 rounded-xl border border-secondary bg-primary p-5 sm:p-6">
      {children}
    </div>
  );
}

export function SettingsField({
  label,
  description,
  inline = false,
  children,
}: {
  label: string;
  description?: string;
  inline?: boolean;
  children: React.ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-primary">{label}</h3>
      {description && <p className="mt-1 text-sm text-tertiary">{description}</p>}
    </div>
  );

  if (inline)
    return (
      <div className="flex items-start justify-between gap-6">
        {text}
        <div className="shrink-0">{children}</div>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {text}
      <div className="min-w-0 max-w-xl">{children}</div>
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
