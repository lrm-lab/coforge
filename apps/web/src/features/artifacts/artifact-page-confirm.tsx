import { useRef } from "react";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { formatFileSize } from "#src/features/files/file-meta";
import { m } from "#src/paraglide/messages";
import type { PageConfirm } from "./artifact-page-bridge";

export type PageConfirmation = { request: PageConfirm; settle: (allowed: boolean) => void };

const LISTED_PATHS = 8;

function copyFor(request: PageConfirm, title: string) {
  switch (request.kind) {
    case "link":
      return {
        title: m.doc_page_link_title(),
        body: m.doc_page_link_body({ title }),
        confirm: m.doc_page_link_open(),
        failed: m.doc_page_link_failed(),
        lines: [request.url],
      };
    case "data": {
      const rest = request.paths.length - LISTED_PATHS;
      return {
        title: m.doc_page_data_title(),
        body: m.doc_page_data_body({ title }),
        confirm: m.doc_page_data_allow(),
        failed: m.doc_page_confirm_failed(),
        lines: [
          ...request.paths.slice(0, LISTED_PATHS),
          ...(rest > 0 ? [m.doc_page_data_more({ count: rest })] : []),
        ],
      };
    }
    case "upload":
      return {
        title: m.doc_page_upload_title(),
        body: m.doc_page_upload_body({
          title,
          name: request.name,
          size: formatFileSize(request.sizeBytes),
        }),
        confirm: m.doc_page_upload_add(),
        failed: m.doc_page_confirm_failed(),
        lines: [],
      };
    case "delete":
      return {
        title: m.doc_page_delete_title(),
        body: m.doc_page_delete_body({ title, name: request.name }),
        confirm: m.doc_page_delete_remove(),
        failed: m.doc_page_confirm_failed(),
        lines: [],
      };
  }
}

export function PageConfirmDialog({
  confirmation,
  title,
}: {
  confirmation: PageConfirmation | null;
  title: string;
}) {
  const shown = useRef(confirmation);
  if (confirmation) shown.current = confirmation;
  const copy = shown.current && copyFor(shown.current.request, title);
  return (
    <ConfirmDialog
      open={confirmation !== null}
      onOpenChange={(open) => !open && confirmation?.settle(false)}
      tone={shown.current?.request.kind === "delete" ? "destructive" : "default"}
      title={copy?.title ?? ""}
      description={copy?.body ?? ""}
      detail={
        copy && copy.lines.length > 0 ? (
          <span className="mt-2 block rounded-lg bg-secondary px-3 py-2 text-sm break-all text-primary">
            {copy.lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        ) : undefined
      }
      confirmLabel={copy?.confirm ?? ""}
      errorMessage={copy?.failed ?? ""}
      onConfirm={async () => confirmation?.settle(true)}
    />
  );
}
