import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { ArrowLeft } from "@untitledui/icons";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { joinPublicChannel } from "./channels.functions";
import { openDirectConversation } from "./conversations.functions";
import type { ForwardFailureCode, ForwardTarget } from "./message-forward";
import { forwardMessage, searchForwardDestinations } from "./message-forward.functions";
import {
  forwardOutcomeView,
  forwardTargetKey,
  forwardTargetLabel,
  forwardedPreview,
  isRetryableForwardFailure,
  isUnjoinedChannel,
  type ForwardSource,
} from "./message-forward-model";
import { ForwardNotePane, ForwardTargetPane } from "./message-forward-panes";

/** How long typing pauses before the targets are searched. */
const SEARCH_DEBOUNCE_MS = 250;

type ForwardChannel = Extract<ForwardTarget, { kind: "channel" }>;

/** A failure the last press of send leaves on screen; `retry` offers "Try Again" where trying the
 * same request again can help. */
type Notice = { text: string; retry?: boolean };

/**
 * The Forward dialog for one message (task #237): pick up to ten destinations, optionally add a
 * note, and send. Wide screens show the targets beside the preview and note; a phone shows them
 * as two steps. It mounts per opening, so its request id is one per opening: pressing send again
 * after a partial failure retries only the destinations that failed.
 */
export function MessageForwardDialog({
  source,
  plainBody,
  onClose,
}: {
  source: ForwardSource;
  /** The message as plain text, as the card previews it. */
  plainBody: string;
  onClose: () => void;
}) {
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const toast = useAppToast();
  const workspaceSlug = useWorkspaceSlug();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const search = useServerFn(searchForwardDestinations);
  const forward = useServerFn(forwardMessage);
  const join = useServerFn(joinPublicChannel);
  const openDirect = useServerFn(openDirectConversation);
  const [requestId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<"destinations" | "note">("destinations");
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<ReadonlyMap<string, ForwardTarget>>(new Map());
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
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
      const result = await forward({
        data: {
          requestId,
          sourceMessageIds: [source.message.id],
          destinations,
          note: note.trim() || undefined,
        },
      });
      const outcome = forwardOutcomeView(result);
      if (outcome.kind === "done") {
        announce(picked, destinations);
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
            ? m.message_forward_partial({ delivered: outcome.delivered, total: outcome.total })
            : m.message_forward_none({ count: outcome.total }),
      });
    } catch (error) {
      setNotice(
        isAppError(error) && error.errorId === "forward-not-forwardable"
          ? { text: m.message_forward_not_forwardable() }
          : isAppErrorCode(error, "NOT_FOUND")
            ? { text: m.message_forward_source_gone() }
            : { retry: true, text: m.message_forward_uncertain() },
      );
    } finally {
      setSending(false);
    }
  }

  /** The toast after a finished forward, with a way to the destination (the first, for several). */
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
        ? m.message_forward_sent_to({ target: forwardTargetLabel(first) })
        : m.message_forward_sent_to_many({ count: delivered.length }),
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
    <ModalOverlay
      isOpen
      isDismissable={!sending}
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
      className="max-lg:[--modal-pb:0px] max-lg:[--modal-pt:0px] max-lg:px-0"
    >
      <Modal className="max-lg:h-(--visual-viewport-height) max-lg:w-full max-lg:rounded-none lg:w-[calc(100vw-4rem)] lg:max-w-4xl">
        <Dialog className="flex h-full max-h-[inherit] flex-col overflow-hidden text-left lg:h-[min(40rem,calc(var(--visual-viewport-height)-4rem))]">
          {desktop || step === "destinations" ? (
            <DialogHeader
              title={m.message_forward_action()}
              onClose={sending ? undefined : onClose}
              className="px-4 pt-4 pb-3 lg:px-6 lg:pt-6"
            />
          ) : (
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={ArrowLeft}
                aria-label={m.message_forward_back()}
                onClick={() => setStep("destinations")}
              />
              <Heading slot="title" className="text-lg font-semibold text-primary">
                {m.message_forward_action()}
              </Heading>
            </div>
          )}
          <div className="flex min-h-0 flex-1 border-t border-secondary lg:grid lg:grid-cols-[2fr_3fr]">
            <div
              className={
                step === "note"
                  ? "flex min-h-0 flex-col max-lg:hidden lg:border-r lg:border-secondary"
                  : "flex min-h-0 flex-1 flex-col lg:border-r lg:border-secondary"
              }
            >
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
            <div
              className={
                step === "destinations"
                  ? "flex min-h-0 flex-col max-lg:hidden"
                  : "flex min-h-0 flex-1 flex-col"
              }
            >
              <ForwardNotePane
                forwarded={forwardedPreview(source, plainBody)}
                attachments={source.message.attachments}
                picked={picked}
                onRemove={(target) => toggle(target, false)}
                note={note}
                onNoteChange={setNote}
                placeholder={placeholder}
                sendLabel={
                  unjoined.length > 0 ? m.message_forward_join_and_send() : m.message_forward_send()
                }
                sending={sending}
                onSend={() => void send()}
                notice={noticeView}
              />
            </div>
          </div>
          {!desktop && step === "destinations" && (
            <div className="flex shrink-0 justify-end border-t border-secondary px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button size="md" isDisabled={picked.length === 0} onPress={() => setStep("note")}>
                {m.message_forward_next()}
              </Button>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
