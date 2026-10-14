import type { ReactNode } from "react";

/** One titled card of the project page; `files` makes it span both columns, under the others. */
export function RepositorySection({
  title,
  files = false,
  children,
  meta,
}: {
  title: string;
  files?: boolean;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section className={files ? "order-3 min-w-0 lg:col-span-2" : "order-2 min-w-0 lg:order-1"}>
      <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-md font-semibold text-primary">{title}</h2>
        {meta}
      </div>
      <div className="min-h-52 overflow-hidden rounded-xl border border-secondary">{children}</div>
    </section>
  );
}
