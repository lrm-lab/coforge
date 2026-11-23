import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { TooltipShortcutLabel, TooltipShortcutRows } from "#src/components/ui/kbd";
import { m } from "#src/paraglide/messages";
import { commentWriteFailure } from "./artifact-comment-composer";
import { syncOwnComments } from "./artifact-comment-queries";
import { postArtifactComment } from "./artifact-comments.functions";
import {
  firstElementAnchorFromSegments,
  serializeInlineSegments,
  type InlineSegment,
} from "./artifact-inline-refs";
import {
  PRIMARY_PILL_CLASS,
  SECONDARY_PILL_CLASS,
  TERTIARY_PILL_CLASS,
} from "./artifact-review-chrome";

export function useImmediateReviewSend({
  artifactId,
  version,
  activePath,
  readSegments,
  pickedPath,
  busy,
  onStart,
  onError,
  onDone,
  onFinally,
}: {
  artifactId: string;
  version: number;
  activePath: string | undefined;
  readSegments: () => InlineSegment[];
  pickedPath: () => string | undefined;
  busy: boolean;
  onStart: () => void;
  onError: (message: string) => void;
  onDone: () => void;
  onFinally: () => void;
}) {
  const queryClient = useQueryClient();
  const sendKeyRef = useRef<{ payload: string; id: string } | null>(null);
  const sendingRef = useRef(false);

  return useCallback(async () => {
    if (busy || sendingRef.current) return;
    const currentSegments = readSegments();
    const serialized = serializeInlineSegments(currentSegments);
    if (!serialized) return;
    const primaryElement = firstElementAnchorFromSegments(currentSegments);
    const targetPath = primaryElement ? (pickedPath() ?? activePath) : activePath;
    const payload = JSON.stringify({ version, serialized, targetPath, primaryElement });
    if (sendKeyRef.current?.payload !== payload) {
      sendKeyRef.current = { payload, id: crypto.randomUUID() };
    }
    sendingRef.current = true;
    onStart();
    try {
      const { id } = await postArtifactComment({
        data: {
          artifactId,
          version,
          comment: {
            body: serialized,
            ...(targetPath ? { path: targetPath } : {}),
            ...(primaryElement ? { anchor: primaryElement } : {}),
            idempotencyKey: sendKeyRef.current.id,
          },
        },
      });
      sendKeyRef.current = null;
      await syncOwnComments(queryClient, artifactId, "posted", [id]);
      onDone();
    } catch (error) {
      onError(commentWriteFailure(error, m.av_cm_err_send()));
    } finally {
      sendingRef.current = false;
      onFinally();
    }
  }, [
    busy,
    readSegments,
    pickedPath,
    activePath,
    version,
    artifactId,
    queryClient,
    onStart,
    onDone,
    onError,
    onFinally,
  ]);
}

export function ArtifactReviewComposeFooter({
  editing,
  preferDraft,
  saving,
  canSave,
  canSend,
  onCancel,
  onSaveDraft,
  onSend,
}: {
  editing: boolean;
  preferDraft: boolean;
  saving: boolean;
  canSave: boolean;
  canSend: boolean;
  onCancel: () => void;
  onSaveDraft: () => void;
  onSend: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-secondary/70 px-3.5 py-2.5">
      <CoForgeMark className="h-3.5 shrink-0 opacity-60 transition-opacity duration-150 hover:opacity-90" />
      <div className="flex items-center gap-1.5">
        <Tooltip title={<TooltipShortcutLabel label={m.controls_cancel()} shortcut="Escape" />}>
          <AriaButton isDisabled={saving} onPress={onCancel} className={TERTIARY_PILL_CLASS}>
            {m.controls_cancel()}
          </AriaButton>
        </Tooltip>
        {editing ? (
          <Tooltip
            title={
              <TooltipShortcutRows
                rows={[
                  { label: m.av_dr_save(), shortcut: "Enter" },
                  { label: m.av_dr_add_and_send_tip(), shortcut: "Mod+Enter" },
                ]}
              />
            }
          >
            <AriaButton
              isDisabled={!canSave}
              data-save-draft=""
              onPress={onSaveDraft}
              className={PRIMARY_PILL_CLASS}
            >
              {m.av_dr_save()}
            </AriaButton>
          </Tooltip>
        ) : (
          <>
            <Tooltip
              title={
                <TooltipShortcutLabel
                  label={m.av_cm_save_draft_tip()}
                  shortcut={preferDraft ? "Enter" : "Mod+Enter"}
                />
              }
            >
              <AriaButton
                isDisabled={!canSave}
                data-save-draft=""
                onPress={onSaveDraft}
                className={preferDraft ? PRIMARY_PILL_CLASS : SECONDARY_PILL_CLASS}
              >
                <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                <span>{m.av_cm_save_draft()}</span>
              </AriaButton>
            </Tooltip>
            <Tooltip
              title={
                <TooltipShortcutLabel
                  label={m.av_cm_send_tip()}
                  shortcut={preferDraft ? "Mod+Enter" : "Enter"}
                />
              }
            >
              <AriaButton
                isDisabled={!canSend}
                data-send-comment=""
                onPress={onSend}
                className={preferDraft ? SECONDARY_PILL_CLASS : PRIMARY_PILL_CLASS}
              >
                {m.av_cm_send()}
              </AriaButton>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
