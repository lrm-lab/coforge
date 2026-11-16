import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  ConversationShareDialog,
  type ShareDialogCopy,
  type ShareNotice,
} from "#src/features/conversations/conversation-share-dialog";
import type { ForwardMessageResult } from "#src/features/conversations/message-forward";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { ArtifactCardFace } from "./artifact-card";
import { ARTIFACTS_KEY, artifactCardQuery } from "./artifact-queries";
import { artifactSendLayout } from "./artifact-send-layout";
import { ARTIFACT_SHARE_NOTE_MAX_LENGTH } from "./artifact-share-input";
import { setArtifactAccess, setArtifactLinkSharing, shareArtifact } from "./artifacts.functions";

const sendCopy = (title: string): ShareDialogCopy => ({
  title: m.doc_send_title({ title }),
  send: m.doc_send_send(),
  sendTo: (count) => m.doc_send_send_to({ count }),
  joinAndSend: m.doc_send_join_and_send(),
  joinNotice: (channels) => m.doc_send_join_notice({ channels }),
  sentTo: (target) => m.doc_send_sent_to({ target }),
  sentToMany: (count) => m.doc_send_sent_to_many({ count }),
  partial: (delivered, total) => m.doc_send_partial({ delivered, total }),
  none: () => m.doc_send_none(),
});

class UnseenRecipients extends Error {
  constructor(readonly count: number) {
    super("recipients cannot see the artifact");
  }
}

export function ArtifactSendDialog({
  artifactId,
  title,
  canChange,
  tier,
  linkAvailable,
  link,
  onClose,
}: {
  artifactId: string;
  title: string;
  canChange: boolean;
  tier: "conversation" | "workspace";
  linkAvailable: boolean;
  link: boolean;
  onClose: () => void;
}) {
  const share = useServerFn(shareArtifact);
  const queryClient = useQueryClient();
  const { data: card } = useQuery(artifactCardQuery(artifactId));
  const anyway = useRef(false);
  const widen = useMutation({
    mutationFn: () => setArtifactAccess({ data: { artifactId, access: "workspace" } }),
  });
  const openLink = useMutation({
    mutationFn: () => setArtifactLinkSharing({ data: { artifactId, enabled: true } }),
  });
  const fix = (change: () => Promise<unknown>) => async () => {
    try {
      await change();
      void queryClient.invalidateQueries({ queryKey: ARTIFACTS_KEY });
      return true;
    } catch {
      return false;
    }
  };
  const heldNotice = (count: number): ShareNotice => ({
    text: m.av_send_held({ count }),
    actions: [
      ...(canChange && tier === "conversation"
        ? [{ label: m.av_send_make_visible(), run: fix(() => widen.mutateAsync()) }]
        : []),
      ...(canChange && linkAvailable
        ? [{ label: m.av_send_turn_on_link(), run: fix(() => openLink.mutateAsync()) }]
        : []),
      {
        label: m.av_send_anyway(),
        run: async () => {
          anyway.current = true;
          return true;
        },
      },
    ],
  });
  return (
    <ConversationShareDialog
      copy={sendCopy(title || m.doc_untitled())}
      preview={card ? <ArtifactCardFace card={card} link={link} /> : null}
      layout={artifactSendLayout}
      noteMaxLength={ARTIFACT_SHARE_NOTE_MAX_LENGTH}
      deliver={async ({ requestId, destinations, note }): Promise<ForwardMessageResult> => {
        const result = await share({
          data: {
            artifactId,
            destinations,
            note,
            requestId,
            unseen: anyway.current ? "send" : "hold",
          },
        });
        if (result.outcome === "held")
          throw new UnseenRecipients(result.held.reduce((sum, h) => sum + h.people + h.agents, 0));
        return {
          outcome: result.outcome,
          results: result.results.map(({ target, ...entry }) => ({
            destination: target,
            ...entry,
          })),
        };
      }}
      errorNotice={(error) =>
        error instanceof UnseenRecipients
          ? heldNotice(error.count)
          : isAppErrorCode(error, "NOT_FOUND")
            ? { text: m.doc_send_gone() }
            : { retry: true, text: m.doc_send_uncertain() }
      }
      onClose={onClose}
    />
  );
}
