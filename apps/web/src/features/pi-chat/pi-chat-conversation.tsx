import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, Folder } from "@untitledui/icons";
import type {
  PiChatCommand,
  PiChatResult,
  PiChatSession,
  WorkbenchRuntime,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";
import { piChatFailureMessage, type PiChatFailure } from "./pi-chat-failure";
import { useExecutePiChat } from "./use-execute-pi-chat";
import { PiChatTranscript } from "./pi-chat-transcript";
import { PiChatComposer } from "./pi-chat-composer";
import { PiChatSessionActions } from "./pi-chat-session-actions";
import { usePiChatScroll } from "./pi-chat-scroll";
import { PiChatDisclosureContext } from "./pi-chat-disclosure";
import { usePiChatStream } from "./pi-chat-stream";
import { usePiChatFiles } from "./pi-chat-files-context";
import {
  loadPiChatHistory,
  preparePiChatSend,
  type PiChatDraft,
  type PiChatHistory,
  type PiChatPendingMessage,
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
  onRecover,
  viewport,
  initialSession,
  runtime,
  controls = false,
}: {
  userId: string;
  workspaceId: string;
  computerId: string;
  sessionId: string;
  workspaceSlug: string;
  viewport: PiChatView;
  initialSession?: PiChatSession;
  runtime?: WorkbenchRuntime;
  controls?: boolean;
  draft: PiChatDraft;
  onDraft(value: PiChatDraft): void;
  onSelect(id?: string): void;
  onRecover(text: string): void;
}) {
  const execute = useExecutePiChat();
  const files = usePiChatFiles();
  const queryClient = useQueryClient();
  const [error, setError] = useState<PiChatFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingSend, setPendingSend] = useState<PiChatPendingMessage>();
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
  const history = useQuery<PiChatHistory>({
    queryKey,
    queryFn: () =>
      reconcile(() =>
        loadPiChatHistory(queryClient.getQueryData<PiChatHistory>(queryKey), (before, cursor) =>
          execute({
            data: { computerId, command: { action: "read", sessionId, before, cursor, runtime } },
          }),
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
  const isCodex =
    (session?.runtime ?? initialSession?.runtime ?? runtime) === RUNTIME_PROVIDER.CODEX;
  const nativeControls = controls && !isCodex;
  const models = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "models"],
    queryFn: () => execute({ data: { computerId, command: { action: "models" } } }),
    enabled: nativeControls,
    staleTime: 60_000,
    retry: false,
  });
  const busy = session?.status === "running";
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [busy]);
  const nativeMessages = history.data?.messages ?? [];
  const pendingMessages = new Map(
    [...(history.data?.pendingMessages ?? []), ...(pendingSend ? [pendingSend] : [])].map(
      (message) => [message.id, message],
    ),
  );
  const positions = new Map(nativeMessages.map((message, index) => [message.id, index]));
  const unseenMessages = [...pendingMessages.values()];
  nativeMessages.forEach((message, index) => {
    if (message.role !== "user") return;
    const matched = unseenMessages.findIndex(
      (pending) =>
        pending.text === message.text && (positions.get(pending.after ?? "") ?? -1) < index,
    );
    if (matched >= 0) unseenMessages.splice(matched, 1);
  });
  const messages = [
    ...nativeMessages,
    ...unseenMessages.map((message) => ({
      id: `pending:${message.id}`,
      role: "user" as const,
      text: message.text,
    })),
  ];
  const position = usePiChatScroll(history.data, sessionId === "new" || !!history.data, viewport);
  const refresh = (id = sessionId) => {
    void queryClient.invalidateQueries({
      queryKey: ["pi-chat", workspaceSlug, computerId, "session", id],
    });
    void queryClient.invalidateQueries({
      queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    });
  };
  const mutate = async (command: PiChatCommand, pending?: PiChatPendingMessage) => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await execute({
        data: {
          computerId,
          command: { ...command, ...(isCodex ? { runtime: RUNTIME_PROVIDER.CODEX } : {}) },
        },
      });
      const accepted = result.session;
      if (accepted) {
        const acceptedKey = ["pi-chat", workspaceSlug, computerId, "session", accepted.id];
        // An older in-flight read must not overwrite the acknowledged session state.
        await queryClient.cancelQueries({ queryKey: acceptedKey, exact: true });
        queryClient.setQueryData<PiChatHistory>(acceptedKey, (current) => {
          const observed =
            current?.session &&
            ((command.action === "start" &&
              current.session.requestIds.includes(command.requestId)) ||
              current.session.updatedAt > accepted.updatedAt);
          const session = observed ? current.session! : accepted;
          const pendingMessages = new Map(
            (current?.pendingMessages ?? []).map((message) => [message.id, message]),
          );
          if (pending) pendingMessages.set(pending.id, pending);
          return {
            ...current,
            session,
            pendingMessages: [...pendingMessages.values()],
            ...(session.status !== "running"
              ? {
                  messages: current?.messages?.filter(
                    (message) => message.id !== "streaming" && !message.id.startsWith("running:"),
                  ),
                  queue: { steering: [], followUp: [] },
                  progress: undefined,
                }
              : {}),
          };
        });
      }
      refresh(accepted?.id);
      return result;
    } catch {
      setError("send");
      return undefined;
    } finally {
      setSubmitting(false);
    }
  };
  const send = async () => {
    const text = latestDraft.current.text.trim();
    if (!text || submitting || (busy && !nativeControls)) return;
    const prepared = preparePiChatSend(latestDraft.current);
    updateDraft(prepared);
    const pending = {
      ...prepared.request!,
      after: nativeMessages
        .filter((message) => message.id !== "streaming" && !message.id.startsWith("running:"))
        .at(-1)?.id,
    };
    setPendingSend(pending);
    const result = await mutate(
      {
        action: "start",
        sessionId: sessionId === "new" ? undefined : sessionId,
        requestId: prepared.request!.id,
        message: text,
        ...(sessionId === "new" && isCodex ? { runtime: RUNTIME_PROVIDER.CODEX } : {}),
        ...(busy ? { mode: prepared.mode ?? "steer" } : {}),
        ...(!busy && !isCodex && prepared.model ? { model: prepared.model } : {}),
      },
      pending,
    );
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
    const before = history.data?.before;
    const cursor = history.data?.cursor;
    if ((!cursor && !before) || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const result = await execute({
        data: {
          computerId,
          command: {
            action: "read",
            sessionId,
            before,
            cursor,
            runtime: isCodex ? RUNTIME_PROVIDER.CODEX : undefined,
          },
        },
      });
      // A polling response started before this page was loaded must not discard it.
      await queryClient.cancelQueries({ queryKey });
      position.capturePrepend();
      queryClient.setQueryData<PiChatHistory>(queryKey, (current) => {
        const merged = new Map((result.messages ?? []).map((message) => [message.id, message]));
        for (const message of current?.messages ?? []) merged.set(message.id, message);
        return {
          ...current,
          messages: [...merged.values()],
          ...(cursor
            ? {
                cursor: result.cursor === cursor ? undefined : result.cursor,
              }
            : { before: Math.min(current?.before ?? before ?? 0, result.before ?? 0) }),
        };
      });
    } catch {
      setError("load");
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
          <>
            {!isCodex && (
              <Button size="sm" color="secondary" iconLeading={Folder} onClick={() => files.open()}>
                {m.pi_chat_files()}
              </Button>
            )}
            {(session ?? initialSession) && (
              <PiChatSessionActions
                session={(session ?? initialSession)!}
                computerId={computerId}
                controls={controls}
                onChanged={refresh}
                onDeleted={() => onSelect()}
              />
            )}
          </>
        }
      />
      {(error || history.isError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-secondary p-3 text-sm text-error-primary"
        >
          {/* The history query failing on its own is a read. */}
          <p>{piChatFailureMessage(error ?? "load")}</p>
          <Button
            color="secondary"
            size="sm"
            onClick={() => {
              setError(null);
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
          {isCodex && history.isSuccess && !nativeMessages.length && (
            <Button
              className="mt-2"
              size="sm"
              color="secondary"
              onClick={() =>
                onRecover(session.interruptedInputs!.map(({ text }) => text).join("\n\n"))
              }
            >
              {m.pi_chat_codex_recover()}
            </Button>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={position.scroll}
          onScroll={position.onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-page [overflow-anchor:none]"
        >
          <div ref={position.content} className="mx-auto max-w-[48rem] py-3">
            {((history.data?.before ?? 0) > 0 || Boolean(history.data?.cursor)) && (
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
                assistant={isCodex ? "Codex" : m.pi_chat_assistant()}
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
                  <p className="mt-2 text-sm text-tertiary">
                    {isCodex ? m.pi_chat_codex_start_hint() : m.pi_chat_start_hint()}
                  </p>
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
      {busy && !!history.data?.approvals?.length && (
        <div className="shrink-0 px-page">
          <div className="mx-auto max-h-48 max-w-[48rem] space-y-3 overflow-y-auto">
            {history.data.approvals.map((approval) => (
              <section
                key={approval.id}
                className="space-y-2 rounded-lg border border-secondary p-3"
              >
                <p className="text-sm font-medium text-primary">
                  {approval.kind === "command"
                    ? m.pi_chat_approve_command()
                    : m.pi_chat_approve_file()}
                </p>
                <pre className="whitespace-pre-wrap wrap-anywhere text-xs text-secondary">
                  {approval.detail}
                </pre>
                <div className="flex flex-wrap gap-2">
                  {(["deny", "allow"] as const).map((decision) => (
                    <Button
                      key={decision}
                      size="sm"
                      color={decision === "allow" ? "primary" : "secondary"}
                      isDisabled={submitting}
                      onClick={() =>
                        void mutate({
                          action: "approval",
                          sessionId,
                          approvalId: approval.id,
                          decision,
                        })
                      }
                    >
                      {decision === "allow" ? m.pi_chat_allow_once() : m.pi_chat_deny()}
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
      <PiChatComposer
        draft={draft}
        onDraft={updateDraft}
        busy={busy}
        pending={submitting}
        controls={nativeControls}
        isCodex={isCodex}
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
        terminalStatus={session && !busy ? statusLabel(session.status, isCodex) : undefined}
      />
    </section>
  );
}

function statusLabel(status: PiChatSession["status"], isCodex: boolean) {
  switch (status) {
    case "running":
      return m.pi_chat_running();
    case "stopped":
      return m.pi_chat_stopped();
    case "interrupted":
      return m.pi_chat_interrupted();
    case "error":
      return isCodex ? m.pi_chat_codex_failed() : m.pi_chat_failed();
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
