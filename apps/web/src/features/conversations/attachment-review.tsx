import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download01, XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from "#src/components/application/modals/modal";
import { Empty, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { AnchorSurface, Anchoring } from "./attachment-anchoring";
import type { AttachmentCommentAnchor } from "./attachment-comment-anchors";
import { AttachmentCommentsPane } from "./attachment-comments";
import { AttachmentPreview } from "./attachment-preview";
import { attachmentPreviewKind } from "./attachment-preview-kind";

type ReviewFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  previewUrl?: string;
};

/** All file types have a discussion, even when this deployment cannot preview their bytes. */
export function AttachmentReviewDialog({
  file,
  children,
}: {
  file: ReviewFile;
  children: ReactNode;
}) {
  const [commentsExpanded, setCommentsExpanded] = useState(true);
  const [commentsOnPhone, setCommentsOnPhone] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageUrlFailed, setImageUrlFailed] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<AttachmentCommentAnchor | null>(null);
  const [surface, setSurface] = useState<AnchorSurface | null>(null);
  const [jumpTo, setJumpTo] = useState<AttachmentCommentAnchor | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const anchoring = useMemo<Anchoring>(
    () => ({
      onSurface: setSurface,
      onComment(anchor) {
        setPendingAnchor(anchor);
        setFocusRequest((count) => count + 1);
        setCommentsExpanded(true);
        setCommentsOnPhone(true);
      },
      onOpenComments() {
        setCommentsExpanded(true);
      },
    }),
    [],
  );
  // Jump once the preview is showing: on a phone it is hidden behind the comments until then.
  useEffect(() => {
    if (!jumpTo || !surface || commentsOnPhone) return;
    surface.jump(jumpTo);
    setJumpTo(null);
  }, [jumpTo, surface, commentsOnPhone]);
  const href = `/api/attachments/${file.id}`;
  const kind = attachmentPreviewKind(file.fileName, file.contentType, file.previewUrl);
  const image = file.contentType.startsWith("image/") && !imageFailed;
  const canPreview = file.contentType.startsWith("image/") || kind !== null;
  const showComments = commentsOnPhone || !canPreview;
  return (
    <DialogTrigger onOpenChange={(open) => !open && setPendingAnchor(null)}>
      {children}
      <ModalOverlay isDismissable>
        <Modal
          className={cn(
            "h-full max-h-full w-full max-sm:overflow-hidden sm:h-[85vh]",
            canPreview ? "sm:max-w-6xl" : "sm:max-w-lg",
          )}
        >
          <Dialog aria-label={file.fileName} className="flex h-full flex-col overflow-hidden">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-secondary p-3 pl-4">
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                    {file.fileName}
                  </p>
                  {canPreview && (
                    <Button
                      color="tertiary"
                      size="sm"
                      onClick={() => {
                        setCommentsOnPhone(!commentsOnPhone);
                        setCommentsExpanded(!commentsExpanded);
                      }}
                    >
                      <span className="lg:hidden">
                        {commentsOnPhone
                          ? m.attachment_comments_preview()
                          : m.attachment_comments_title()}
                      </span>
                      <span className="hidden lg:inline">
                        {commentsExpanded
                          ? m.attachment_comments_collapse()
                          : m.attachment_comments_expand()}
                      </span>
                    </Button>
                  )}
                  <ButtonUtility
                    icon={Download01}
                    size="sm"
                    color="tertiary"
                    tooltip={m.conversation_attachment_download()}
                    href={`${href}?download`}
                  />
                  <ButtonUtility
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    tooltip={m.controls_close()}
                    onClick={close}
                  />
                </div>
                <div className="flex min-h-0 flex-1">
                  {canPreview && (
                    <div
                      className={cn(
                        "min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex",
                        commentsOnPhone ? "hidden" : "flex",
                      )}
                    >
                      {image ? (
                        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                          <img
                            src={!imageUrlFailed && file.previewUrl ? file.previewUrl : href}
                            alt={file.fileName}
                            className="max-h-full max-w-full object-contain"
                            onError={() => {
                              if (file.previewUrl && !imageUrlFailed) setImageUrlFailed(true);
                              else setImageFailed(true);
                            }}
                          />
                        </div>
                      ) : kind ? (
                        <AttachmentPreview
                          fileName={file.fileName}
                          kind={kind}
                          href={href}
                          previewUrl={file.previewUrl}
                          anchoring={anchoring}
                          commentsOpen={commentsExpanded}
                        />
                      ) : (
                        <Empty>
                          <EmptyTitle>{m.attachment_comments_no_preview()}</EmptyTitle>
                        </Empty>
                      )}
                    </div>
                  )}
                  <div
                    className={cn(
                      "min-h-0 min-w-0 flex-1",
                      canPreview && "lg:w-[22rem] lg:flex-none lg:border-l lg:border-secondary",
                      canPreview && (commentsExpanded ? "lg:block" : "lg:hidden"),
                      showComments ? "block" : "hidden",
                    )}
                  >
                    <AttachmentCommentsPane
                      attachmentId={file.id}
                      fileName={file.fileName}
                      pendingAnchor={pendingAnchor}
                      focusRequest={focusRequest}
                      onClearAnchor={(anchor) =>
                        setPendingAnchor((current) => (current === anchor ? null : current))
                      }
                      surface={surface}
                      onJump={(anchor) => {
                        setCommentsOnPhone(false);
                        setJumpTo(anchor);
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
