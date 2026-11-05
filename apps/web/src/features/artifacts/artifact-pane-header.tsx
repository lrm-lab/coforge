import type { File02 } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactEditorStatus } from "./use-artifact-editor";

/** The artifact's state as its header has it: the editor's, or a web page's (never edited). */
export type ArtifactStatus = ArtifactEditorStatus | "page";

/**
 * What the header says beside the title (Frank, 11-05: edits save by themselves, with no
 * versions to show): only a save in flight, or that the viewer may only read. The
 * region stays in place while silent, so what it then says is read out.
 */
export function StatusLine({ status }: { status: ArtifactStatus }) {
  const label =
    status === "saving" ? m.doc_saving() : status === "readOnly" ? m.doc_read_only() : null;
  return (
    <span role="status" className="shrink-0 text-xs whitespace-nowrap text-tertiary">
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
