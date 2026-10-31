import { fileTypeLabel } from "#src/features/files/file-meta";

// The icon bar is drawn at full text color, as on Raft; the tertiary gray reads as disabled.
export const TOOLBAR_ICON = "text-fg-primary hover:text-fg-primary";

/** A file's type tag and name, the title of the bar over a preview or an image. */
export function ReviewTitle({ fileName, contentType }: { fileName: string; contentType: string }) {
  const typeLabel = fileTypeLabel(fileName, contentType);
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2">
      {typeLabel && (
        <span className="shrink-0 rounded-sm bg-secondary px-1 py-0.5 text-xs leading-none font-semibold text-tertiary ring-1 ring-secondary ring-inset">
          {typeLabel}
        </span>
      )}
      <span className="truncate text-sm font-semibold text-primary">{fileName}</span>
    </p>
  );
}
