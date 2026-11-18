"use client";

import { useState } from "react";
import { Trash01 as Trash2 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { cn } from "#src/lib/utils";
import { isAllowedFileCardHref } from "#src/features/records/report-editor/utils/file-cards";
import { ReportImageZoom } from "#src/features/records/report-image-zoom";

const REVEAL_ON_HOVER =
  "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100";

export type AttachmentInput = {
  kind: "url";
  url: string;
  filename: string;
  contentType?: string;
  uploading?: boolean;
  width?: number;
  height?: number;
  forceKind?: "image" | "file";
};

function isImageUrl(url: string, filename: string, forceKind?: "image" | "file"): boolean {
  if (forceKind === "image") return true;
  if (forceKind === "file") return false;
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i.test(filename || url);
}

export function Attachment({
  attachment,
  editable = false,
  selected = false,
  onDelete,
}: {
  attachment: AttachmentInput;
  editable?: boolean;
  selected?: boolean;
  onDelete?: () => void;
}) {
  const { url, filename, uploading, width, height, forceKind } = attachment;
  const asImage = isImageUrl(url, filename, forceKind);
  const [zoomOpen, setZoomOpen] = useState(false);

  if (uploading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-dashed border-secondary px-3 py-2 text-xs text-tertiary",
          asImage && "image-node",
        )}
        data-uploading=""
      >
        Uploading…
      </div>
    );
  }

  if (asImage) {
    return (
      <div
        className={cn("image-node group relative inline-block", selected && "ring-2 ring-brand")}
      >
        <figure className="image-figure m-0">
          <img
            src={url}
            alt={filename || ""}
            width={width}
            height={height}
            className="max-w-full cursor-zoom-in rounded-md"
            draggable={false}
            onClick={() => setZoomOpen(true)}
          />
        </figure>
        {zoomOpen ? (
          <ReportImageZoom src={url} alt={filename || ""} onClose={() => setZoomOpen(false)} />
        ) : null}
        {editable && onDelete ? (
          <AriaButton
            type="button"
            className={cn(
              "absolute top-2 right-2 rounded-md bg-primary p-1 text-fg-quaternary shadow-sm transition-opacity hover:text-fg-quaternary_hover",
              REVEAL_ON_HOVER,
              selected && "opacity-100!",
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Remove image"
          >
            <Trash2 className="size-3.5" />
          </AriaButton>
        ) : null}
      </div>
    );
  }

  const safeHref = isAllowedFileCardHref(url) ? url : undefined;

  return (
    <div
      className={cn(
        "file-card group flex items-center gap-3 rounded-md border border-secondary bg-secondary px-3 py-2",
        selected && "ring-2 ring-brand",
      )}
    >
      <div className="min-w-0 flex-1">
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-sm font-medium text-primary underline-offset-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {filename || "file"}
          </a>
        ) : (
          <span className="truncate text-sm font-medium">{filename || "file"}</span>
        )}
      </div>
      {editable && onDelete ? (
        <AriaButton
          type="button"
          className={cn(
            "rounded-md p-1 text-fg-quaternary transition-opacity hover:bg-primary_hover hover:text-fg-quaternary_hover",
            REVEAL_ON_HOVER,
            selected && "opacity-100!",
          )}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Remove file"
        >
          <Trash2 className="size-3.5" />
        </AriaButton>
      ) : null}
    </div>
  );
}
