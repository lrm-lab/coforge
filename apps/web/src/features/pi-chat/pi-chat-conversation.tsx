import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowLeft } from "@untitledui/icons";
import type { PiChatCommand, PiChatSession, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";
import { PiChatTranscript } from "./pi-chat-transcript";
import { PiChatComposer } from "./pi-chat-composer";
import { PiChatSessionActions } from "./pi-chat-session-actions";
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
  controls = false,
}: {
  userId: string;
  workspaceId: string;
  computerId: string;
  sessionId: string;
  workspaceSlug: string;
  viewport: PiChatView;
  initialSession?: PiChatSession;
  controls?: boolean;
  draft: PiChatDraft;
  onDraft(value: PiChatDraft): void;
  onSelect(id?: string): void;
}) {
  const execute = useServerFn(executePiChat);
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingSend, setPendingSend] = useState<{ id: string; text: string }>();
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const updateDraft = (value: PiChatDraft) => {
    latestDraft.current = value;
    onDraft(value);
  };
  const [now, setNow] = useState(Date.now);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const queryKey = ["pi-chat", workspaceSlug, computerId, "session", sessionId];
  const reconcile = usePiChatStream({ userId, workspaceId, computerId }, workspaceSlug, sessionId);
  const history = useQuery({
    queryKey,
    queryFn: () =>
      reconcile(() =>
        loadPiChatHistory(queryClient.getQueryData<PiChatResult>(queryKey), (before) =>
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
  const models = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "models"],
    queryFn: () => execute({ data: { computerId, command: { action: "models" } } }),
    enabled: controls,
    staleTime: 60_000,
    retry: false,
  });
  const session = history.data?.session;
  const busy = session?.status === "running";
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [busy]);
  const messages = [
    ...(history.data?.messages ?? []),
    ...(pendingSend && !history.data?.session?.requestIds.includes(pendingSend.id)
      ? [{ id: `pending:${pendingSend.id}`, role: "user" as const, text: pendingSend.text }]
      : []),
  ];
  const position = usePiChatScroll(history.data, sessionId === "new" || !!history.data, viewport);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({
      queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    });
  };
  const mutate = async (command: PiChatCommand) => {
    setError(false);
    setSubmitting(true);
    try {
      const result = await execute({ data: { computerId, command } });
      refresh();
      return result;
    } catch {
      setError(true);
      return undefined;
    } finally {
      setSubmitting(false);
    }
  };
  const send = async () => {
    const text = latestDraft.current.text.trim();
    if (!text || submitting || (busy && !controls)) return;
    const prepared = preparePiChatSend(latestDraft.current);
    updateDraft(prepared);
    setPendingSend(prepared.request);
    const result = await mutate({
      action: "start",
      sessionId: sessionId === "new" ? undefined : sessionId,
      requestId: prepared.request!.id,
      message: text,
      ...(busy ? { mode: prepared.mode ?? "steer" } : {}),
      ...(!busy && prepared.model ? { model: prepared.model } : {}),
    });
    setPendingSend(undefined);
    if (result?.session) {
      if (latestDraft.current === prepared)
        updateDraft({ ...prepared, text: "", request: undefined });
      position.followLatest();
      if (sessionId === "new") onSelect(result.session.id);
    }
  };
  const takeQueue = async () => {
    const result = await mutate({ action: "take_queue", sessionId });
    if (!result?.takenQueue) return;
    const { steering, followUp } = result.takenQueue;
    if (!steering.length && !followUp.length) return;
    const restored = [...steering, ...followUp].join("\n\n");
    const current = latestDraft.current;
    updateDraft({
      ...current,
      text:
        current.text === restored || current.text.startsWith(`${restored}\n\n`)
          ? current.text
          : [restored, current.text].filter(Boolean).join("\n\n"),
      mode: steering.length ? "steer" : "followUp",
      request: undefined,
    });
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
          (session ?? initialSession) && (
            <PiChatSessionActions
              session={(session ?? initialSession)!}
              computerId={computerId}
              controls={controls}
              onChanged={refresh}
              onDeleted={() => onSelect()}
            />
          )
        }
      />
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
      {!!session?.interruptedInputs?.length && (
        <div role="alert" className="border-b border-secondary p-3 text-sm text-warning-primary">
          <p>{m.pi_chat_inputs_interrupted()}</p>
          <ul className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
            {session.interruptedInputs.map((input) => (
              <li key={input.id}>{input.text}</li>
            ))}
          </ul>
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
              <PiChatTranscript
                messages={messages}
                busy={busy}
                status={busy ? progressLabel(history.data, now) : undefined}
              />
              {pendingSend && !busy && (
                <p role="status" className="text-xs text-tertiary">
                  {m.pi_chat_sending()}
                </p>
              )}
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
      <PiChatComposer
        draft={draft}
        onDraft={updateDraft}
        busy={busy}
        pending={submitting}
        controls={controls}
        models={models.data?.models}
        modelError={models.isError}
        sessionModel={session?.model}
        queue={history.data?.queue}
        heldQueue={session?.heldQueue}
        onSend={send}
        onStop={async () => {
          await mutate({ action: "stop", sessionId });
        }}
        onTakeQueue={takeQueue}
        terminalStatus={session && !busy ? statusLabel(session.status) : undefined}
      />
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

function progressLabel(result: PiChatResult | undefined, now: number) {
  const progress = result?.progress;
  if (!progress) return m.pi_chat_phase_waiting();
  const seconds = Math.max(0, Math.floor((now - progress.updatedAt) / 1000));
  if (seconds >= 30) return m.pi_chat_phase_wait({ seconds: String(seconds) });
  switch (progress.phase) {
    case "waiting":
      return m.pi_chat_phase_waiting();
    case "thinking":
      return m.pi_chat_phase_thinking();
    case "answering":
      return m.pi_chat_phase_answering();
    case "tool":
      return m.pi_chat_phase_tool({ tool: progress.toolName ?? "…" });
    case "retrying":
      return m.pi_chat_phase_retrying();
    case "compacting":
      return m.pi_chat_phase_compacting();
  }
}
