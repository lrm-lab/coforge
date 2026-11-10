import { useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { joinPublicChannel } from "./channels.functions";
import { openDirectConversation } from "./conversations.functions";
import type { ForwardFailureCode, ForwardMessageResult, ForwardTarget } from "./message-forward";
import { searchForwardDestinations } from "./message-forward.functions";
import {
  forwardOutcomeView,
  forwardTargetKey,
  forwardTargetLabel,
  isRetryableForwardFailure,
  isUnjoinedChannel,
} from "./message-forward-model";
import { ForwardComposer, ForwardTargetPane } from "./message-forward-panes";

/** How long typing pauses before the targets are searched. */
const SEARCH_DEBOUNCE_MS = 250;

type ForwardChannel = Extract<ForwardTarget, { kind: "channel" }>;

/** A failure the last press of send leaves on screen; `retry` offers "Try Again" where trying the
 * same request again can help. */
export type ShareNotice = { text: string; retry?: boolean };

/** The words that name what is being sent: "Forward" for a message, "Send" for an artifact. */
export type ShareDialogCopy = {
  title: string;
  send: string;
  /** The button once targets are picked: "Forward to 2". */
  sendTo: (count: number) => string;
  joinAndSend: string;
  /** Said over the note while sending will join channels first (the button is only an icon). */
  joinNotice: (channels: string) => string;
  sentTo: (target: string) => string;
  sentToMany: (count: number) => string;
  partial: (delivered: number, total: number) => string;
  none: (count: number) => string;
};

/**
 * Sends something into conversations (task #237's Forward, and an artifact's Send): pick up to ten
 * destinations, optionally add a note, and send. One column at every width (Frank, 11-10, design
 * B; task #50): search, the targets one line each with the picked ones first, then what arrives
 * as one line that opens, the note and the send button; a phone has it as a sheet from the bottom
 * edge, as every picker there. It mounts per opening, so its request id is one per
 * opening: pressing send again after a partial failure retries only the destinations that failed.
 * What is sent, and how, is the caller's: `preview` shows it and `deliver` sends it.
 */
export function ConversationShareDialog({
  copy,
  summary,
  preview,
  noteMaxLength,
  deliver,
  errorNotice,
  onClose,
  onDelivered,
}: {
  copy: ShareDialogCopy;
  /** What arrives, in one line: who and the start of it. */
  summary: ReactNode;
  /** What arrives, in full, when that line is opened. */
  preview: ReactNode;
  noteMaxLength: number;
  /** One request to every destination, under the opening's request id. */
  deliver: (input: {
    requestId: string;
    destinations: string[];
    note: string | undefined;
  }) => Promise<ForwardMessageResult>;
  /** What a request that threw says (and whether trying again can help). */
  errorNotice: (error: unknown) => ShareNotice;
  onClose: () => void;
  /** Every destination took it; the dialog closes too. */
  onDelivered?: () => void;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const workspaceSlug = useWorkspaceSlug();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const search = useServerFn(searchForwardDestinations);
  const join = useServerFn(joinPublicChannel);
  const openDirect = useServerFn(openDirectConversation);
  const [requestId] = useState(() => crypto.randomUUID());
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<ReadonlyMap<string, ForwardTarget>>(new Map());
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<ShareNotice | null>(null);
  const [failed, setFailed] = useState<ReadonlyMap<string, ForwardFailureCode>>(new Map());
  // A direct conversation opened for a target, and a channel joined, stay so for a retry: the
  // retry must name the same destinations its request id was first sent with.
  const directIds = useRef(new Map<string, string>());
  const joinedIds = useRef(new Set<string>());

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const targets = useQuery({
    queryKey: ["forward-destinations", workspaceId, term],
    queryFn: () => search({ data: { q: term, limit: 20 } }),
    placeholderData: keepPreviousData,
    gcTime: 0,
  });

  const picked = [...selected.values()];
  // Picked destinations or a typed note are the user's edits; every way out asks before dropping
  // them.
  const guard = useUnsavedChangesGuard({
    // Mounted only while open.
    overlayOpen: true,
    dirty: picked.length > 0 || note.trim() !== "",
    close: onClose,
  });
  // A public channel the viewer has not joined is joined on send; the button says so, so nothing
  // joins silently.
  const unjoined = picked.filter(
    (target): target is ForwardChannel =>
      target.kind === "channel" &&
      isUnjoinedChannel(target) &&
      !joinedIds.current.has(target.conversationId),
  );
  const placeholder =
    picked.length === 0
      ? m.message_forward_note_placeholder_none()
      : picked.length === 1
        ? m.message_forward_note_placeholder_target({ target: forwardTargetLabel(picked[0]!) })
        : m.message_forward_note_placeholder();

  function toggle(target: ForwardTarget, on: boolean) {
    setSelected((previous) => {
      const next = new Map(previous);
      if (on) next.set(forwardTargetKey(target), target);
      else next.delete(forwardTargetKey(target));
      return next;
    });
  }

  /** The conversation a target forwards into: a person or Agent without a DM gets one opened. */
  async function destinationOf(target: ForwardTarget) {
    if (target.kind === "channel") return target.conversationId;
    const key = forwardTargetKey(target);
    const known = target.conversationId ?? directIds.current.get(key);
    if (known) return known;
    const { conversationId } = await openDirect({
      data: target.kind === "person" ? { userId: target.userId } : { agentId: target.agentId },
    });
    directIds.current.set(key, conversationId);
    return conversationId;
  }

  async function send() {
    if (picked.length === 0 || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const joins = await Promise.allSettled(
        unjoined.map((target) => join({ data: { channelId: target.conversationId } })),
      );
      const notJoined: ForwardChannel[] = [];
      unjoined.forEach((target, index) => {
        if (joins[index]!.status === "fulfilled") joinedIds.current.add(target.conversationId);
        else notJoined.push(target);
      });
      if (notJoined.length > 0) {
        setNotice({
          text: m.message_forward_join_failed({
            target: notJoined.map(forwardTargetLabel).join(", "),
          }),
        });
        return;
      }
      const destinations = await Promise.all(picked.map(destinationOf));
      const result = await deliver({ requestId, destinations, note: note.trim() || undefined });
      const outcome = forwardOutcomeView(result);
      if (outcome.kind === "done") {
        announce(picked, destinations);
        onDelivered?.();
        onClose();
        return;
      }
      setFailed(
        new Map(
          picked.flatMap((target, index) => {
            const code = outcome.failed.get(destinations[index]!);
            return code ? [[forwardTargetKey(target), code] as const] : [];
          }),
        ),
      );
      setNotice({
        // An archived, read-only or inaccessible destination refuses again; Try Again is only
        // for one that may take it on another attempt.
        retry: [...outcome.failed.values()].some(isRetryableForwardFailure),
        text:
          outcome.kind === "partial"
            ? copy.partial(outcome.delivered, outcome.total)
            : copy.none(outcome.total),
      });
    } catch (error) {
      setNotice(errorNotice(error));
    } finally {
      setSending(false);
    }
  }

  /** The toast after a finished send, with a way to the destination (the first, for several). */
  function announce(delivered: ForwardTarget[], destinations: string[]) {
    const first = delivered[0]!;
    const destination = destinations[0]!;
    const goTo = () =>
      void router.navigate(
        first.kind === "channel"
          ? {
              to: "/w/$workspaceSlug/channel/$channelId",
              params: { workspaceSlug, channelId: destination },
            }
          : { to: "/w/$workspaceSlug/dm/$dmId", params: { workspaceSlug, dmId: destination } },
      );
    toast.success(
      delivered.length === 1
        ? copy.sentTo(forwardTargetLabel(first))
        : copy.sentToMany(delivered.length),
      { action: { label: m.message_forward_view_in_chat(), onClick: goTo } },
    );
  }

  const noticeView = notice && (
    <div className="flex items-start justify-between gap-3">
      <p role="alert" className="text-sm text-error-primary">
        {notice.text}
      </p>
      {notice.retry && (
        <Button
          size="sm"
          color="link-color"
          isDisabled={sending}
          onPress={() => void send()}
          className="shrink-0"
        >
          {m.message_forward_try_again()}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <ModalOverlay
        isOpen
        isDismissable={!sending}
        onOpenChange={(open) => {
          if (!open && !sending) guard.requestClose();
        }}
        className="max-sm:px-0 max-sm:[--modal-pb:0px]"
      >
        <Modal className="w-full max-sm:rounded-t-2xl max-sm:rounded-b-none sm:max-w-lg">
          <Dialog className="flex max-h-[inherit] flex-col overflow-y-auto text-left max-sm:h-[min(88dvh,var(--visual-viewport-height))]">
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-quaternary/40 sm:hidden"
            />
            <DialogHeader
              title={copy.title}
              onClose={sending ? undefined : guard.requestClose}
              className="px-4 pt-3 pb-3 sm:px-6 sm:pt-5"
            />
            {/* 20rem of list, giving way when the window is short (or zoomed) down to two rows;
                shorter still, the dialog scrolls, so the send button is never out of reach. */}
            <div className="flex min-h-24 flex-1 flex-col sm:flex-[0_1_20rem]">
              <ForwardTargetPane
                query={query}
                onQueryChange={setQuery}
                targets={targets.data ?? null}
                failed={failed}
                error={targets.isError}
                selected={selected}
                onToggle={toggle}
              />
            </div>
            <ForwardComposer
              summary={summary}
              preview={preview}
              canSend={picked.length > 0 && !sending}
              note={note}
              onNoteChange={setNote}
              noteMaxLength={noteMaxLength}
              placeholder={placeholder}
              sendLabel={
                unjoined.length > 0
                  ? copy.joinAndSend
                  : picked.length > 0
                    ? copy.sendTo(picked.length)
                    : copy.send
              }
              sending={sending}
              onSend={() => void send()}
              notice={noticeView}
              joinNotice={
                unjoined.length > 0
                  ? copy.joinNotice(
                      new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(
                        unjoined.map(forwardTargetLabel),
                      ),
                    )
                  : undefined
              }
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
