import { MessageChatSquare } from "@untitledui/icons";

import { fileTypeLabel } from "#src/features/files/file-meta";
import { m } from "#src/paraglide/messages";

/** A file's type as a small monospace tag ("MP3", "PDF"), or nothing when it has none. */
export function FileTypeTag({ fileName, contentType }: { fileName: string; contentType: string }) {
  const label = fileTypeLabel(fileName, contentType);
  if (!label) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-[4px] bg-secondary px-1 font-mono text-xs font-semibold text-tertiary ring-1 ring-secondary ring-inset">
      {label}
    </span>
  );
}

/** A file's comment count as a mark, or nothing without comments; `commentsSuffix` says it in
 * words for the control's name. */
export function CommentCountMark({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
      <MessageChatSquare className="size-3.5" />
      {count}
    </span>
  );
}

/** ", 2 comments" after a file control's name, or nothing without comments. */
export function commentsSuffix(count: number) {
  return count > 0 ? `, ${m.conversation_attachment_comment_count({ count })}` : "";
}
