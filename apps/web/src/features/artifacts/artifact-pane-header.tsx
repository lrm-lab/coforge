import {
  ClockRewind,
  DotsHorizontal,
  File02,
  Link01,
  Maximize01,
  Minimize01,
  Trash01,
  XClose,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ArtifactEditorStatus } from "./use-artifact-editor";

/** What the header says of the document's state, beside its title. */
export function StatusLine({
  status,
  version,
}: {
  status: ArtifactEditorStatus | "old";
  version: number;
}) {
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
    <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

/**
 * The document pane's header (task #385): its title and state, then history, full screen, more
 * (copy link, delete) and close, as the mockup draws them.
 */
export function ArtifactPaneHeader({
  title,
  status,
  version,
  full,
  history = false,
  canDelete = false,
  onToggleHistory,
  onToggleFull,
  onCopyLink,
  onDelete,
  onClose,
}: {
  title: string;
  status: ArtifactEditorStatus | "old";
  version: number;
  full: boolean;
  history?: boolean;
  canDelete?: boolean;
  /** Absent where there is no history yet (a draft, a document that did not load). */
  onToggleHistory?: () => void;
  onToggleFull: () => void;
  /** Absent where there is nothing to link to or delete yet: no "more" menu. */
  onCopyLink?: () => void;
  /** Offered only with `canDelete`: absent where there is nothing to delete yet. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b border-secondary pr-2 pl-4">
      <File02 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <h2 className="min-w-0 truncate text-sm font-semibold text-primary">{title}</h2>
      <StatusLine status={status} version={version} />
      <span className="flex-1" />
      {onToggleHistory && (
        <ButtonUtility
          icon={ClockRewind}
          size="sm"
          color="tertiary"
          tooltip={m.doc_history()}
          aria-pressed={history}
          className={cn(history && "bg-active")}
          onClick={onToggleHistory}
        />
      )}
      <ButtonUtility
        icon={full ? Minimize01 : Maximize01}
        size="sm"
        color="tertiary"
        tooltip={full ? m.doc_exit_fullscreen() : m.doc_fullscreen()}
        className="max-md:hidden"
        onClick={onToggleFull}
      />
      {onCopyLink && (
        <Dropdown.Root>
          <ButtonUtility icon={DotsHorizontal} size="sm" color="tertiary" tooltip={m.doc_more()} />
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={m.doc_more()}
              onAction={(key) => (key === "delete" ? onDelete?.() : onCopyLink())}
            >
              <Dropdown.Item id="copy" icon={Link01} label={m.doc_copy_link()} />
              {canDelete && <Dropdown.Separator />}
              {canDelete && <Dropdown.Item id="delete" icon={Trash01} label={m.doc_delete()} />}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
      <ButtonUtility
        icon={XClose}
        size="sm"
        color="tertiary"
        tooltip={m.doc_close()}
        onClick={onClose}
      />
    </header>
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
