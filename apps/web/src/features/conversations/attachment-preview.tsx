import { useEffect, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { mediaMimeType, type AttachmentPreviewKind } from "./attachment-preview-kind";
import type { Anchoring } from "./attachment-anchoring";
import { LinesPreview, MarkdownPreview } from "./anchored-previews";
import { CsvPreview } from "./csv-preview";
import { HtmlRegionPreview } from "./html-region-preview";

/** Media has no range requests here (see `MediaPreview`), so the whole file is held in memory;
 * past this the reader is better served by the download. */
const MEDIA_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

type FetchState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; tooLarge: boolean };

/** Fetches one attachment through the authenticated route, bounded by `maxBytes`. */
function useAttachmentBlob(href: string, maxBytes: number): FetchState<Blob> {
  const [state, setState] = useState<FetchState<Blob>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    (async () => {
      try {
        const response = await fetch(href, { signal: controller.signal });
        if (!response.ok) throw new Error(`attachment preview failed (${response.status})`);
        const blob = await response.blob();
        if (blob.size > maxBytes) {
          setState({ status: "error", tooLarge: true });
          return;
        }
        setState({ status: "ready", value: blob });
      } catch (error) {
        if (controller.signal.aborted) return;
        void error;
        setState({ status: "error", tooLarge: false });
      }
    })();
    return () => controller.abort();
  }, [href, maxBytes]);
  return state;
}

function PreviewStatus({
  state,
  href,
}: {
  state: { status: "loading" } | { status: "error"; tooLarge: boolean };
  href: string;
}) {
  if (state.status === "loading")
    return (
      <p className="p-4 text-sm text-tertiary sm:p-6">
        {m.conversation_attachment_preview_loading()}
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-3 p-4 sm:p-6">
      <p className="text-sm text-tertiary">
        {state.tooLarge
          ? m.conversation_attachment_preview_too_large()
          : m.conversation_attachment_preview_failed()}
      </p>
      <Button size="sm" color="secondary" href={`${href}?download`}>
        {m.conversation_attachment_download()}
      </Button>
    </div>
  );
}

/**
 * A preview of one attachment, fetched by the browser from the authenticated attachment route.
 *
 * Nothing about the server's delivery changes: the route keeps serving every non-image attachment
 * as an opaque `application/octet-stream` download, so a stored HTML file still can never be
 * loaded as a document in this origin. The bytes are read here instead, and rendered per kind:
 *
 * - `markdown` goes through the same sanitized Markdown renderer a message body uses, so a `.md`
 *   attachment reads exactly like Markdown written in the conversation.
 * - `text` (a `.txt` plain-text file) reads literally — rendered as escaped text in a scrollable
 *   monospace pre, never parsed as Markdown.
 * - `csv` is parsed here and laid out as a table of escaped text.
 * - `html` goes into a frame in a unique opaque origin, with forms, popups and same-origin access
 *   denied, where only our own bridge script may run (`html-preview-bridge.ts`). The document
 *   renders, but it cannot run code, read this page, or reach our cookies.
 * - `video`/`audio` play from a Blob built with a MIME type from our own allowlist, so the
 *   browser decodes media and never sniffs the bytes into markup.
 */
export function AttachmentPreview({
  fileName,
  kind,
  href,
  previewUrl,
  text,
  anchoring,
  commentsOpen,
}: {
  fileName: string;
  kind: AttachmentPreviewKind;
  /** The authenticated attachment URL; also the download target offered on failure. */
  href: string;
  /** The signed delivery URL; required for `pdf`, unused by the other kinds. */
  previewUrl?: string;
  /** A text kind's content, read before the preview opens (`readPreviewText`). */
  text?: string;
  /** Lets the reader comment on a place in a Markdown, text, CSV or HTML file. */
  anchoring?: Anchoring;
  /** Whether the comments show beside the preview (an HTML file's comment mode needs them). */
  commentsOpen?: boolean;
}) {
  if (kind === "pdf")
    return previewUrl ? (
      <PdfPreview fileName={fileName} previewUrl={previewUrl} />
    ) : (
      <PreviewStatus state={{ status: "error", tooLarge: false }} href={href} />
    );
  if (kind === "video" || kind === "audio")
    return <MediaPreview fileName={fileName} kind={kind} href={href} />;
  if (text === undefined)
    return <PreviewStatus state={{ status: "error", tooLarge: false }} href={href} />;
  return (
    <TextPreview
      fileName={fileName}
      kind={kind}
      text={text}
      anchoring={anchoring}
      commentsOpen={commentsOpen}
    />
  );
}

/**
 * A PDF in the browser's own viewer, loaded from the signed delivery URL.
 *
 * Deliberately **not** sandboxed, and deliberately **not** from our origin. An empty `sandbox`
 * blocks the built-in viewer outright (verified in Chromium: the frame renders the broken-document
 * placeholder instead of the PDF), so isolation has to come from somewhere else — and it does: the
 * signed URL is on the delivery origin, which holds none of our cookies, so a document the sender
 * controls is loaded outside our session's origin. `referrerpolicy` keeps the signed URL out of
 * outbound referrers.
 *
 * That boundary is not a promise made in this comment: `attachmentPreviewKind` only reports `pdf`
 * for a URL it has parsed and found to be off this origin (`isFrameableDocumentUrl`), and the
 * server refuses to sign delivery URLs on its own origin at all, so a misconfigured deployment
 * gets the plain download card instead of a framed document.
 */
function PdfPreview({ fileName, previewUrl }: { fileName: string; previewUrl: string }) {
  return (
    <iframe
      aria-label={fileName}
      src={previewUrl}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-secondary"
    />
  );
}

function TextPreview({
  fileName,
  kind,
  text,
  anchoring,
  commentsOpen,
}: {
  fileName: string;
  kind: "markdown" | "html" | "text" | "csv";
  text: string;
  anchoring?: Anchoring;
  commentsOpen?: boolean;
}) {
  if (kind === "markdown") return <MarkdownPreview text={text} anchoring={anchoring} />;

  // Plain text reads literally, not as Markdown and not through an iframe: the bytes are rendered
  // as React text (auto-escaped, no script surface), in a scrollable monospace pre that preserves
  // the file's line breaks and leading whitespace.
  if (kind === "text") return <LinesPreview text={text} anchoring={anchoring} />;
  if (kind === "csv") return <CsvPreview text={text} anchoring={anchoring} />;

  return (
    <HtmlRegionPreview
      fileName={fileName}
      text={text}
      anchoring={anchoring}
      commentsOpen={commentsOpen}
    />
  );
}

/**
 * Plays one media attachment from a Blob URL.
 *
 * The whole file is fetched before playback starts (bounded by `MEDIA_PREVIEW_MAX_BYTES`): the
 * attachment route serves an opaque download rather than a range-request media response, so there
 * is nothing to stream from yet. Real streaming would mean serving media inline with its own
 * content type — a change to what this origin is willing to render, which is a separate decision.
 */
function MediaPreview({
  fileName,
  kind,
  href,
}: {
  fileName: string;
  kind: "video" | "audio";
  href: string;
}) {
  const blob = useAttachmentBlob(href, MEDIA_PREVIEW_MAX_BYTES);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const mimeType = mediaMimeType(fileName);
    if (blob.status !== "ready" || !mimeType) {
      setUrl(null);
      return;
    }
    // Retyped from our allowlist rather than trusting the stored content type.
    const objectUrl = URL.createObjectURL(new Blob([blob.value], { type: mimeType }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [blob, fileName]);

  if (blob.status !== "ready") return <PreviewStatus state={blob} href={href} />;
  if (!url)
    return (
      <p className="p-4 text-sm text-tertiary sm:p-6">
        {m.conversation_attachment_preview_loading()}
      </p>
    );

  if (kind === "audio")
    return (
      <div className="p-4 sm:p-6">
        <audio src={url} controls className="w-full" aria-label={fileName} />
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <video src={url} controls className="max-h-full max-w-full" aria-label={fileName} />
    </div>
  );
}
