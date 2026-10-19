import { FileIcon } from "@untitledui/file-icons";

import { cn } from "#src/lib/utils";
import { fileIconType } from "./file-icon-type";

/** A file's glyph. Light and dark are the icon set's own themes, so both render and CSS shows one. */
export function FileTypeIcon({
  fileName,
  contentType,
  className,
}: {
  fileName: string;
  contentType?: string;
  className?: string;
}) {
  const type = fileIconType(fileName, contentType);
  return (
    <>
      <FileIcon
        type={type}
        theme="light"
        aria-hidden="true"
        className={cn("shrink-0 dark:hidden", className)}
      />
      <FileIcon
        type={type}
        theme="dark"
        aria-hidden="true"
        className={cn("shrink-0 not-dark:hidden", className)}
      />
    </>
  );
}
