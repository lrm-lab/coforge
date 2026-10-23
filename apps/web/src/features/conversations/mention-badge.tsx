/** The "@" marker of a row whose conversation mentions the viewer: a light-violet pill. */
export function MentionBadge() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-primary px-1.5 text-xs font-semibold leading-none text-brand-secondary"
    >
      @
    </span>
  );
}
