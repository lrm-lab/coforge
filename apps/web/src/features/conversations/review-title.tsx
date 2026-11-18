import { fileTypeLabel } from "#src/features/files/file-meta";

export function ReviewTitle({ fileName, contentType }: { fileName: string; contentType: string }) {
  const typeLabel = fileTypeLabel(fileName, contentType);
  return (
    <p className="flex min-w-0 flex-1 items-center gap-2">
      {typeLabel && <span className="shrink-0 text-xs font-medium text-tertiary">{typeLabel}</span>}
      <span className="truncate text-sm font-medium text-primary">{fileName}</span>
    </p>
  );
}
