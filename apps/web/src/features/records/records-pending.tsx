import { m } from "#src/paraglide/messages";

export function RecordsPending() {
  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden bg-primary"
      aria-busy="true"
      aria-label={m.empty_records_loading()}
    >
      <div className="hidden w-72 shrink-0 flex-col border-r border-secondary p-3 md:flex">
        <div className="h-8 w-full animate-pulse rounded-lg bg-secondary" />
        <div className="mt-3 flex flex-col gap-2">
          <div className="h-9 w-full animate-pulse rounded-lg bg-secondary" />
          <div className="h-9 w-11/12 animate-pulse rounded-lg bg-secondary" />
          <div className="h-9 w-10/12 animate-pulse rounded-lg bg-secondary" />
          <div className="h-9 w-full animate-pulse rounded-lg bg-secondary" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
        <div className="h-7 w-56 animate-pulse rounded bg-secondary" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-secondary" />
        <div className="mt-2 h-40 w-full max-w-2xl animate-pulse rounded-xl bg-secondary" />
      </div>
    </div>
  );
}
