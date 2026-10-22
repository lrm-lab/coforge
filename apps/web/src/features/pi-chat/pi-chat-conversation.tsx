import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDown,
  ArrowLeft,
  DotsHorizontal,
  Edit03,
  Send01,
  StopCircle,
  Trash01,
} from "@untitledui/icons";
import type { PiChatCommand, PiChatSession, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { PageHeader } from "#src/components/layout/page-header";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";
import { PiChatTranscript } from "./pi-chat-transcript";
import { usePiChatScroll } from "./pi-chat-scroll";
import { PiChatDisclosureContext } from "./pi-chat-disclosure";
import { usePiChatStream } from "./pi-chat-stream";
import {
  loadPiChatHistory,
  preparePiChatSend,
  type PiChatDraft,
  type PiChatView,
} from "./pi-chat-state";

export function PiChatConversation({
  userId,
  workspaceId,
  computerId,
  sessionId,
  workspaceSlug,
  draft,
  onDraft,
  onSelect,
  viewport,
  initialSession,
}: {
  userId: string;
  workspaceId: string;
  computerId: string;
  sessionId: string;
  workspaceSlug: string;
  viewport: PiChatView;
  initialSession?: PiChatSession;
  draft: PiChatDraft;
  onDraft(value: PiChatDraft): void;
  onSelect(id?: string): void;
}) {
  const execute = useServerFn(executePiChat);
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const queryKey = ["pi-chat", workspaceSlug, computerId, "session", sessionId];
  const reconcile = usePiChatStream({ userId, workspaceId, computerId }, workspaceSlug, sessionId);
  const history = useQuery({
    queryKey,
    queryFn: async () =>
      reconcile(
        await loadPiChatHistory(queryClient.getQueryData<PiChatResult>(queryKey), (before) =>
          execute({ data: { computerId, command: { action: "read", sessionId, before } } }),
        ),
      ),
    enabled: sessionId !== "new",
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error"
        ? 3_000
        : query.state.data?.session?.status === "running"
          ? 10_000 // Watchdog/recovery only; live content arrives on the shared realtime connection.
          : false,
  });
  const session = history.data?.session;
  const busy = session?.status === "running";
  const messages = [
    ...(history.data?.messages ?? []),
    ...(submitting && draft.request && !history.data?.session?.requestIds.includes(draft.request.id)
      ? [{ id: `pending:${draft.request.id}`, role: "user" as const, text: draft.request.text }]
      : []),
  ];
  const position = usePiChatScroll(history.data, sessionId === "new" || !!history.data, viewport);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["pi-chat", workspaceSlug, computerId] });
  };
  const mutate = async (command: PiChatCommand) => {
    setError(false);
    setSubmitting(true);
    try {
      const result = await execute({ data: { computerId, command } });
      await refresh();
      return result;
    } catch {
      setError(true);
      return undefined;
    } finally {
      setSubmitting(false);
    }
  };
  const send = async () => {
    const text = draft.text.trim();
    if (!text || busy || submitting) return;
    const prepared = preparePiChatSend(draft);
    onDraft(prepared);
    const result = await mutate({
      action: "start",
      sessionId: sessionId === "new" ? undefined : sessionId,
      requestId: prepared.request!.id,
      message: text,
    });
    if (result?.session) {
      onDraft({ text: "" });
      position.followLatest();
      onSelect(result.session.id);
    }
  };
  const loadOlder = async () => {
    const cursor = history.data?.before;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setError(false);
    try {
      const result = await execute({
        data: { computerId, command: { action: "read", sessionId, before: cursor } },
      });
      // A polling response started before this page was loaded must not discard it.
      await queryClient.cancelQueries({ queryKey });
      position.capturePrepend();
      queryClient.setQueryData<PiChatResult>(queryKey, (current) => {
        const merged = new Map((result.messages ?? []).map((message) => [message.id, message]));
        for (const message of current?.messages ?? []) merged.set(message.id, message);
        return {
          ...current,
          messages: [...merged.values()],
          before: Math.min(current?.before ?? cursor, result.before ?? 0),
        };
      });
    } catch {
      setError(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        heading={session?.title ?? initialSession?.title ?? m.pi_chat_new()}
        leading={
          <Button
            size="sm"
            color="tertiary"
            iconLeading={ArrowLeft}
            aria-label={m.pi_chat_back()}
            className="lg:hidden"
            onClick={() => onSelect()}
          />
        }
        actions={
          session && (
            <Dropdown.Root>
              <Button
                color="tertiary"
                size="sm"
                iconLeading={DotsHorizontal}
                aria-label={m.pi_chat_actions()}
                isDisabled={busy || submitting}
              />
              <Dropdown.Popover>
                <Dropdown.Menu aria-label={m.pi_chat_actions()}>
                  <Dropdown.Item
                    id="rename"
                    icon={Edit03}
                    onAction={() => {
                      setTitle(session.title);
                      setRenaming(true);
                      setDeleting(false);
                    }}
                  >
                    {m.pi_chat_rename()}
                  </Dropdown.Item>
                  <Dropdown.Item
                    id="delete"
                    icon={Trash01}
                    onAction={() => {
                      setDeleting(true);
                      setRenaming(false);
                    }}
                  >
                    {m.pi_chat_delete()}
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          )
        }
      />
      {renaming && (
        <form
          className="flex gap-2 border-b border-secondary p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate({ action: "rename", sessionId, title }).then((result) => {
              if (result) setRenaming(false);
            });
          }}
        >
          <Input
            aria-label={m.pi_chat_name()}
            value={title}
            onChange={setTitle}
            maxLength={120}
            autoFocus
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" isDisabled={!title.trim() || submitting}>
            {m.pi_chat_save()}
          </Button>
          <Button size="sm" color="secondary" onClick={() => setRenaming(false)}>
            {m.pi_chat_cancel()}
          </Button>
        </form>
      )}
      {deleting && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-secondary p-3 text-sm text-primary"
        >
          <p>{m.pi_chat_delete_confirm()}</p>
          <Button
            color="primary-destructive"
            size="sm"
            isDisabled={submitting}
            onClick={() =>
              void mutate({ action: "delete", sessionId }).then((result) => {
                if (result) onSelect();
              })
            }
          >
            {m.pi_chat_delete()}
          </Button>
          <Button size="sm" color="secondary" onClick={() => setDeleting(false)}>
            {m.pi_chat_cancel()}
          </Button>
        </div>
      )}
      {(error || history.isError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-secondary p-3 text-sm text-error-primary"
        >
          <p>{m.pi_chat_connection_error()}</p>
          <Button
            color="secondary"
            size="sm"
            onClick={() => {
              setError(false);
              void refresh();
            }}
          >
            {m.pi_chat_retry()}
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={position.scroll}
          onScroll={position.onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-page [overflow-anchor:none]"
        >
          <div ref={position.content} className="mx-auto max-w-[48rem] py-3">
            {(history.data?.before ?? 0) > 0 && (
              <div className="py-3">
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={loadingOlder}
                  isLoading={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {m.pi_chat_older()}
                </Button>
              </div>
            )}
            {history.isPending && sessionId !== "new" && (
              <p role="status" className="py-6 text-sm text-tertiary">
                {m.pi_chat_loading()}
              </p>
            )}
            <PiChatDisclosureContext
              value={{
                expanded: viewport.expanded,
                closed: (viewport.closed ??= new Set()),
                onInspect: position.pauseFollowing,
              }}
            >
              <PiChatTranscript messages={messages} busy={busy || submitting} />
            </PiChatDisclosureContext>
            {messages.length === 0 &&
              !history.isError &&
              (sessionId === "new" || !history.isPending) && (
                <div className="py-10">
                  <p className="text-lg font-semibold text-primary">{m.pi_chat_start_title()}</p>
                  <p className="mt-2 text-sm text-tertiary">{m.pi_chat_start_hint()}</p>
                </div>
              )}
          </div>
        </div>
        {position.away && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              color="secondary"
              size="sm"
              iconLeading={ArrowDown}
              onClick={position.followLatest}
              className="pointer-events-auto shadow-sm"
            >
              {m.pi_chat_latest()}
            </Button>
          </div>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="shrink-0 px-page pt-2 pb-4"
      >
        <div className="mx-auto max-w-[48rem] space-y-2">
          {session?.status && (
            <p
              role="status"
              className={cn(
                "text-xs text-tertiary",
                session.status === "error" && "text-error-primary",
              )}
            >
              {statusLabel(session.status)}
            </p>
          )}
          <div className="overflow-hidden rounded-xl border border-primary bg-primary shadow-xs focus-within:border-secondary">
            <TextArea
              aria-label={m.pi_chat_message()}
              placeholder={m.pi_chat_placeholder()}
              value={draft.text}
              onChange={(text) => onDraft({ ...draft, text })}
              maxLength={100_000}
              rows={1}
              textAreaClassName="min-h-12 max-h-48 resize-none rounded-none bg-transparent text-sm shadow-none ring-0 focus:ring-0 [field-sizing:content]"
              isDisabled={submitting}
              onTextAreaKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <span className="min-w-0 text-xs text-tertiary wrap-anywhere">
                {session?.model || m.pi_chat_model_default()}
              </span>
              {busy ? (
                <Button
                  color="secondary"
                  size="sm"
                  iconLeading={StopCircle}
                  isDisabled={submitting}
                  onClick={() => void mutate({ action: "stop", sessionId })}
                >
                  {m.pi_chat_stop()}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  iconLeading={Send01}
                  isDisabled={!draft.text.trim() || submitting || (sessionId !== "new" && !session)}
                  isLoading={submitting}
                >
                  {m.pi_chat_send()}
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-tertiary">{m.pi_chat_keyboard_hint()}</p>
        </div>
      </form>
    </section>
  );
}

function statusLabel(status: PiChatSession["status"]) {
  switch (status) {
    case "running":
      return m.pi_chat_running();
    case "stopped":
      return m.pi_chat_stopped();
    case "interrupted":
      return m.pi_chat_interrupted();
    case "error":
      return m.pi_chat_failed();
    case "idle":
      return m.pi_chat_ready();
  }
}
