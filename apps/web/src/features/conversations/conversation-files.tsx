import { queryOptions, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Download01, MarkerPin01 } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";

import { previewKindFor } from "./attachment-preview-kind";
import { AttachmentReviewDialog } from "./attachment-review";
import { loadConversationFiles, type ConversationFile } from "./conversation-files.functions";
import { attachmentUrl } from "./attachment-card";
import { LoadingImage } from "./loading-image";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const conversationFilesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "files", conversationId],
    queryFn: async () => (await loadConversationFiles({ data: { conversationId } })).files,
    staleTime: 0,
  });

function useConversationFiles(conversationId: string) {
  return useQuery(conversationFilesQuery(conversationId));
}

/** Exported for the Files-tab card test: the card-level click target is a structure, not a style. */
export function FileRow({
  file,
  timeZone,
  onOpenMessage,
}: {
  file: ConversationFile;
  timeZone: string | null;
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const timeFormat = useTimeFormat();
  const href = attachmentUrl(file);
  const messageId = file.messageId;
  const isImage = file.inlineImage;
  const download = (
    <ButtonUtility
      icon={Download01}
      size="sm"
      color="secondary"
      tooltip={m.files_download()}
      href={`${href}?download`}
    />
  );
  // One preview affordance per card, covering the whole card body — the thumbnail *and* the name —
  // with the actions beside it: a file opens wherever the reader clicks the card, not only on the
  // thumbnail (or, worse, only on the file name). Every file can open its discussion, including a type without a preview.
  const previewable = previewKindFor(file);
  const previewLabel = isImage
    ? file.fileName
    : previewable
      ? m.conversation_attachment_preview_open({ name: file.fileName })
      : m.attachment_comments_open({ name: file.fileName });
  // `Button` wraps children in one `display: block` span. The row owns its own flex so the
  // thumbnail and name sit side by side instead of stacking, then centering in the leftover
  // `flex-1` space (`justify-center` is the Button default).
  const cardBody = (
    <span className="flex w-full min-w-0 items-center gap-3">
      {isImage ? (
        <LoadingImage
          src={file.previewUrl ?? href}
          fallbackSrc={file.previewUrl ? href : undefined}
          alt=""
          className="size-10 shrink-0 rounded-lg ring-1 ring-secondary ring-inset"
          imgClassName="size-full object-cover"
          failed={
            <FileTypeIcon
              fileName={file.fileName}
              contentType={file.contentType}
              className="size-6"
            />
          }
        />
      ) : (
        <FileTypeIcon fileName={file.fileName} contentType={file.contentType} className="size-10" />
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium text-primary">{file.fileName}</span>
        <span className="mt-0.5 block truncate text-xs text-tertiary">
          <span className="tabular-nums">{getReadableFileSize(file.sizeBytes)}</span>
          {" · "}
          <time dateTime={new Date(file.createdAt).toISOString()}>
            {formatDateForDisplay(file.createdAt, timeZone, undefined, timeFormat)}
          </time>
        </span>
      </span>
    </span>
  );
  return (
    <li className="flex items-center gap-2 rounded-xl border border-secondary bg-primary py-2 pr-2 pl-3">
      <div className="min-w-0 flex-1">
        <AttachmentReviewDialog file={file}>
          {({ loading }) => (
            <Button
              color="tertiary"
              noTextPadding
              isLoading={loading}
              aria-label={previewLabel}
              className="h-auto w-full min-w-0 justify-start rounded-lg p-0 text-left hover:bg-transparent [&>span]:w-full [&>span]:min-w-0"
            >
              {cardBody}
            </Button>
          )}
        </AttachmentReviewDialog>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {messageId && onOpenMessage && (
          <ButtonUtility
            icon={MarkerPin01}
            size="sm"
            color="secondary"
            tooltip={m.files_locate_message()}
            onClick={() => void onOpenMessage(messageId).catch(() => {})}
          />
        )}
        {download}
      </div>
    </li>
  );
}

/** Card-shaped placeholder rows, in the real list's layout so nothing shifts when files land. */
function FilesSkeleton() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="sr-only">
        {m.files_loading()}
      </p>
      <ul
        aria-hidden="true"
        className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 motion-safe:animate-pulse md:px-6"
      >
        {["w-44", "w-56", "w-36"].map((nameWidth) => (
          <li
            key={nameWidth}
            className="flex items-center gap-2 rounded-xl border border-secondary bg-primary py-2 pr-2 pl-3"
          >
            <Skeleton className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <Skeleton className={`h-4 ${nameWidth} max-w-2/3`} />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </div>
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <Skeleton className="size-8 shrink-0 rounded-md" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConversationFilesPanel({
  conversationId,
  onOpenMessage,
}: {
  conversationId: string;
  /** Files-tab "locate in chat": switches to the chat view scrolled to the file's message. */
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const { data: files, isPending, isError } = useConversationFiles(conversationId);
  if (isPending) {
    return <FilesSkeleton />;
  }
  if (isError) {
    return <p className="p-4 text-sm text-destructive md:px-6">{m.files_load_failed()}</p>;
  }
  if (!files || files.length === 0) {
    return <p className="p-4 text-sm text-tertiary md:px-6">{m.files_empty()}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 md:px-6">
        {files.map((file) => (
          <FileRow key={file.id} file={file} timeZone={timeZone} onOpenMessage={onOpenMessage} />
        ))}
      </ul>
    </div>
  );
}
