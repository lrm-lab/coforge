import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Plus, RefreshCw01, Send01, StopCircle } from "@untitledui/icons";
import type {
  PiChatCommand,
  PiChatMessage as Message,
  PiChatSession,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { PageHeader } from "#src/components/layout/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";
import { PiChatMessage } from "./pi-chat-message";

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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = `${computerId}:${sessionId ?? "new"}`;
  const execute = useServerFn(executePiChat);
  const sessions = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    queryFn: () => execute({ data: { computerId: computerId!, command: { action: "list" } } }),
    enabled: configured && !!computerId,
    refetchInterval: (query) =>
      query.state.data?.sessions?.some((row) => row.status === "running") ? 2000 : false,
    retry: false,
  });
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
              color="tertiary"
              iconLeading={Plus}
              aria-label={m.pi_chat_new()}
              onClick={() => select(computerId, "new")}
            />
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
          {sessions.data?.sessions
            ?.filter((session) =>
              session.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            )
            .map((session) => (
              <Link
                key={session.id}
                to="/w/$workspaceSlug/pi-chat"
                params={{ workspaceSlug }}
                search={{ computer: computerId, session: session.id }}
                aria-current={sessionId === session.id ? "page" : undefined}
                className={cn(
                  "mb-1 block rounded-lg px-3 py-2 text-sm text-primary hover:bg-secondary",
                  sessionId === session.id && "bg-active",
                )}
              >
                <p className="truncate font-medium">{session.title}</p>
                {session.status === "running" && (
                  <p className="mt-1 text-xs text-tertiary">{m.pi_chat_running()}</p>
                )}
              </Link>
            ))}
          {sessions.data?.sessions?.length === 0 && (
            <p className="p-3 text-sm text-tertiary">{m.pi_chat_no_sessions()}</p>
          )}
        </div>
      </section>
      {sessionId ? (
        <Conversation
          key={key}
          computerId={computerId}
          sessionId={sessionId}
          workspaceSlug={workspaceSlug}
          draft={drafts[key] ?? ""}
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
}: {
  computerId: string;
  sessionId: string;
  workspaceSlug: string;
  draft: string;
  onDraft(value: string): void;
  onSelect(id?: string): void;
}) {
  const execute = useServerFn(executePiChat);
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [older, setOlder] = useState<Message[]>([]);
  const [before, setBefore] = useState<number>();
  const request = useRef<{ id: string; text: string } | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const queryKey = ["pi-chat", workspaceSlug, computerId, "session", sessionId];
  const history = useQuery({
    queryKey,
    queryFn: () => execute({ data: { computerId, command: { action: "read", sessionId } } }),
    enabled: sessionId !== "new",
    retry: false,
    refetchInterval: (query) => (query.state.data?.session?.status === "running" ? 700 : false),
  });
  const session = history.data?.session;
  const busy = session?.status === "running";
  const messages = [...older, ...(history.data?.messages ?? [])].filter(
    (message, index, array) => array.findIndex((entry) => entry.id === message.id) === index,
  );
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [history.data]);
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
    const text = draft.trim();
    if (!text || busy || submitting) return;
    if (request.current?.text !== text) request.current = { id: crypto.randomUUID(), text };
    const result = await mutate({
      action: "start",
      sessionId: sessionId === "new" ? undefined : sessionId,
      requestId: request.current.id,
      message: text,
    });
    if (result?.session) {
      onDraft("");
      request.current = undefined;
      follow.current = true;
      onSelect(result.session.id);
    }
  };
  const loadOlder = async () => {
    const cursor = before ?? history.data?.before;
    if (!cursor) return;
    const result = await mutate({ action: "read", sessionId, before: cursor });
    if (result?.messages) {
      setOlder((current) => [...result.messages!, ...current]);
      setBefore(result.before);
    }
  };
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        heading={session?.title ?? m.pi_chat_new()}
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
            <>
              <Button
                size="sm"
                color="tertiary"
                isDisabled={busy || submitting}
                onClick={() => {
                  setTitle(session.title);
                  setRenaming(!renaming);
                  setDeleting(false);
                }}
              >
                {m.pi_chat_rename()}
              </Button>
              <Button
                size="sm"
                color="tertiary"
                isDisabled={busy || submitting}
                onClick={() => {
                  setDeleting(!deleting);
                  setRenaming(false);
                }}
              >
                {m.pi_chat_delete()}
              </Button>
            </>
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
      <div
        ref={scroll}
        onScroll={(event) => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-page"
      >
        <div className="mx-auto max-w-[52rem] divide-y divide-secondary">
          {(before ?? history.data?.before ?? 0) > 0 && (
            <div className="py-3">
              <Button
                size="sm"
                color="secondary"
                isDisabled={submitting}
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
          {messages.map((message) => (
            <PiChatMessage key={message.id} message={message} />
          ))}
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="border-t border-secondary px-page py-3"
      >
        <div className="mx-auto max-w-[52rem] space-y-2">
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
          <TextArea
            aria-label={m.pi_chat_message()}
            placeholder={m.pi_chat_placeholder()}
            value={draft}
            onChange={onDraft}
            maxLength={100_000}
            rows={3}
            isDisabled={submitting}
            onTextAreaKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
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
                isDisabled={!draft.trim() || submitting || (sessionId !== "new" && !session)}
                isLoading={submitting}
              >
                {m.pi_chat_send()}
              </Button>
            )}
          </div>
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
