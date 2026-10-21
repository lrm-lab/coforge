import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDown,
  ArrowLeft,
  DotsHorizontal,
  Edit03,
  Plus,
  RefreshCw01,
  SearchLg,
  Send01,
  StopCircle,
  Trash01,
} from "@untitledui/icons";
import type { PiChatCommand, PiChatSession, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { PageHeader } from "#src/components/layout/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";
import { PiChatTranscript } from "./pi-chat-transcript";
import { PiChatSessionList } from "./pi-chat-session-list";
import { usePiChatScroll } from "./pi-chat-scroll";
import { PiChatDisclosureContext } from "./pi-chat-disclosure";
import {
  loadPiChatHistory,
  preparePiChatSend,
  type PiChatDraft,
  type PiChatView,
} from "./pi-chat-state";

type Props = {
  workspaceSlug: string;
  computers: { id: string; name: string }[];
  configured: boolean;
  computerId?: string;
  sessionId?: string;
  select(computerId: string, sessionId?: string): void;
};

export function PiChatPage(props: Props) {
  const { workspaceSlug, computers, configured, sessionId, select } = props;
  const computerId = props.computerId ?? computers[0]?.id;
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, PiChatDraft>>({});
  const key = `${workspaceSlug}:${computerId}:${sessionId ?? "new"}`;
  const execute = useServerFn(executePiChat);
  const sessions = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    queryFn: () => execute({ data: { computerId: computerId!, command: { action: "list" } } }),
    enabled: configured && !!computerId,
    refetchInterval: (query) =>
      query.state.data?.sessions?.some((row) => row.status === "running") ? 2000 : false,
    retry: false,
  });
  const viewports = useRef(new Map<string, PiChatView>());
  if (!viewports.current.has(key))
    viewports.current.set(key, { top: 0, follow: true, expanded: new Set() });
  const selection = useRef(key);
  selection.current = key;
  if (!configured || !computerId)
    return (
      <main className="flex h-full min-h-0 flex-col">
        <PageHeader heading={m.pi_chat_title()} />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {configured ? m.pi_chat_no_computer() : m.pi_chat_unconfigured()}
            </EmptyTitle>
            <EmptyDescription>
              {configured ? m.pi_chat_no_computer_hint() : m.pi_chat_unconfigured_hint()}
            </EmptyDescription>
          </EmptyHeader>
          {configured && (
            <Link
              to="/w/$workspaceSlug/computers"
              params={{ workspaceSlug }}
              className="text-sm text-brand-secondary"
            >
              {m.navigation_computers()}
            </Link>
          )}
        </Empty>
      </main>
    );
  return (
    <main className="flex h-full min-h-0 min-w-0 overflow-hidden bg-primary">
      <section
        aria-label={m.pi_chat_sessions()}
        className={cn(
          "w-full min-w-0 flex-col lg:flex lg:w-[18rem] lg:shrink-0 lg:border-r lg:border-secondary",
          sessionId ? "hidden" : "flex",
        )}
      >
        <PageHeader
          heading={m.pi_chat_title()}
          actions={
            <Button
              size="sm"
              color="secondary"
              iconLeading={Plus}
              onClick={() => select(computerId, "new")}
            >
              {m.pi_chat_new()}
            </Button>
          }
        />
        <div className="space-y-3 p-3">
          <Select
            aria-label={m.pi_chat_computer()}
            size="sm"
            selectedKey={computerId}
            onSelectionChange={(id) => {
              if (id) select(String(id));
            }}
            items={computers.map((computer) => ({ id: computer.id, label: computer.name }))}
          >
            {(computer) => <Select.Item id={computer.id}>{computer.label}</Select.Item>}
          </Select>
          <Input
            size="sm"
            aria-label={m.pi_chat_search()}
            icon={SearchLg}
            placeholder={m.pi_chat_search()}
            value={search}
            onChange={setSearch}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.isPending && (
            <p role="status" className="p-3 text-sm text-tertiary">
              {m.pi_chat_loading()}
            </p>
          )}
          {sessions.isError && (
            <div role="alert" className="space-y-2 p-3 text-sm text-error-primary">
              <p>{m.pi_chat_connection_error()}</p>
              <Button
                size="sm"
                color="secondary"
                iconLeading={RefreshCw01}
                onClick={() => void sessions.refetch()}
              >
                {m.pi_chat_retry()}
              </Button>
            </div>
          )}
          {sessions.data?.sessions && !sessions.isError && (
            <PiChatSessionList
              sessions={sessions.data.sessions}
              search={search}
              workspaceSlug={workspaceSlug}
              computerId={computerId}
              sessionId={sessionId}
              clearSearch={() => setSearch("")}
            />
          )}
        </div>
      </section>
      {sessionId ? (
        <Conversation
          key={key}
          computerId={computerId}
          sessionId={sessionId}
          workspaceSlug={workspaceSlug}
          viewport={viewports.current.get(key)!}
          initialSession={sessions.data?.sessions?.find((session) => session.id === sessionId)}
          draft={drafts[key] ?? { text: "" }}
          onDraft={(value) => setDrafts((current) => ({ ...current, [key]: value }))}
          onSelect={(id) => {
            if (selection.current === key) select(computerId, id);
          }}
        />
      ) : (
        <section className="hidden min-w-0 flex-1 lg:flex">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{m.pi_chat_start_title()}</EmptyTitle>
              <EmptyDescription>{m.pi_chat_start_hint()}</EmptyDescription>
            </EmptyHeader>
            <Button iconLeading={Plus} onClick={() => select(computerId, "new")}>
              {m.pi_chat_new()}
            </Button>
          </Empty>
        </section>
      )}
    </main>
  );
}

function Conversation({
  computerId,
  sessionId,
  workspaceSlug,
  draft,
  onDraft,
  onSelect,
  viewport,
  initialSession,
}: {
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
  const history = useQuery({
    queryKey,
    queryFn: () =>
      loadPiChatHistory(queryClient.getQueryData<PiChatResult>(queryKey), (before) =>
        execute({ data: { computerId, command: { action: "read", sessionId, before } } }),
      ),
    enabled: sessionId !== "new",
    retry: false,
    refetchInterval: (query) => (query.state.data?.session?.status === "running" ? 700 : false),
  });
  const session = history.data?.session;
  const busy = session?.status === "running";
  const messages = history.data?.messages ?? [];
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
              value={{ expanded: viewport.expanded, onInspect: position.pauseFollowing }}
            >
              <PiChatTranscript messages={messages} busy={busy} />
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
