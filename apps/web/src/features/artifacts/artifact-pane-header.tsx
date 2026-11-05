import type { File02 } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactEditorStatus } from "./use-artifact-editor";

/** What the header says of the artifact: the editor's state, an old version, or a web page's version. */
export type ArtifactStatus = ArtifactEditorStatus | "old" | "page";

/** What the header says of the artifact's state, beside its title. */
export function StatusLine({ status, version }: { status: ArtifactStatus; version: number }) {
  // A web page is never edited here: only its version, with no state dot (Frank, 11-05).
  if (status === "page")
    return (
      <span role="status" className="shrink-0 text-xs whitespace-nowrap text-tertiary">
        {m.doc_version({ number: String(version) })}
      </span>
    );
  const [dot, label] = {
    saved: [
      "bg-fg-success-secondary",
      version > 0 ? m.doc_saved({ number: String(version) }) : m.doc_version_none(),
    ],
    unsaved: ["bg-fg-warning-secondary", m.doc_unsaved()],
    saving: ["bg-fg-quaternary", m.doc_saving()],
    conflict: ["bg-fg-warning-secondary", m.doc_conflict_status()],
    readOnly: ["bg-fg-quaternary", m.doc_read_only()],
    old: ["bg-fg-quaternary", m.doc_read_only()],
  }[status];
  return (
    <span
      role="status"
      className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-tertiary"
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

/** A line across the top of the document: what changed and the way on from it. */
export function ArtifactBanner({
  tone,
  icon: Icon,
  children,
  actions,
}: {
  tone: "info" | "warning";
  icon: typeof File02;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      className={cn(
        "mx-4 mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 text-sm",
        tone === "warning"
          ? "border-utility-yellow-300 bg-warning-primary text-warning-primary"
          : "border-secondary bg-brand-primary_alt text-secondary",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {actions && <span className="flex flex-wrap items-center gap-2">{actions}</span>}
    </div>
  );
}
