import { lazy, Suspense } from "react";

import { cn } from "#src/lib/utils";

const FileTypeIconInner = lazy(() => import("./file-type-icon-inner"));

export function FileTypeIcon({
  fileName,
  contentType,
  className,
}: {
  fileName: string;
  contentType?: string;
  className?: string;
}) {
  return (
    <Suspense
      fallback={<span aria-hidden="true" className={cn("inline-block shrink-0", className)} />}
    >
      <FileTypeIconInner fileName={fileName} contentType={contentType} className={className} />
    </Suspense>
  );
}
