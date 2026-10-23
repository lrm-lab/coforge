import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, RefreshCw01, SearchLg } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { PageHeader } from "#src/components/layout/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { executePiChat, getPiChatComputers } from "./pi-chat.functions";
import { PiChatFilesContext } from "./pi-chat-files-context";
import { PiChatFilesPanel } from "./pi-chat-files-panel";
import { PiChatSessionList } from "./pi-chat-session-list";
import type { PiChatDraft, PiChatView } from "./pi-chat-state";
import { PiChatConversation } from "./pi-chat-conversation";

type Props = {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  computers: { id: string; name: string; controls?: boolean; files?: boolean }[];
  configured: boolean;
  computerId?: string;
  sessionId?: string;
  select(computerId: string, sessionId?: string): void;
};

export function PiChatPage(props: Props) {
  const { workspaceSlug, configured, sessionId, select } = props;
  const getComputers = useServerFn(getPiChatComputers);
  const capabilities = useQuery({
    queryKey: ["pi-chat", workspaceSlug, props.userId, "computers"],
    queryFn: () => getComputers(),
    refetchInterval: 10_000,
    enabled: configured,
    retry: false,
  });
  const computers = capabilities.data?.computers ?? props.computers;
  const computerId = props.computerId ?? computers[0]?.id;
  const controls = computers.find((computer) => computer.id === computerId)?.controls ?? false;
  const computer = computers.find((computer) => computer.id === computerId);
  const [filePanels, setFilePanels] = useState<Record<string, { open: boolean; path?: string }>>(
    {},
  );
  const filePanel = filePanels[computerId ?? ""];
  const openFiles = (path?: string) =>
    setFilePanels((current) => ({ ...current, [computerId!]: { open: true, path } }));
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, PiChatDraft>>({});
  const key = `${workspaceSlug}:${computerId}:${sessionId ?? "new"}`;
  const execute = useServerFn(executePiChat);
  const sessions = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    queryFn: () => execute({ data: { computerId: computerId!, command: { action: "list" } } }),
    enabled: configured && !!computerId,
    refetchInterval: (query) =>
      query.state.status === "error"
        ? 3_000
        : query.state.data?.sessions?.some((row) => row.status === "running")
          ? 2000
          : false,
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
    <PiChatFilesContext value={{ supported: computer?.files ?? false, open: openFiles }}>
      <main className="flex h-full min-h-0 min-w-0 overflow-hidden bg-primary">
        <section
          aria-label={m.pi_chat_sessions()}
          className={cn(
            "w-full min-w-0 flex-col lg:flex lg:w-[18rem] lg:shrink-0 lg:border-r lg:border-secondary",
            sessionId ? (filePanel?.open ? "hidden 2xl:flex" : "hidden") : "flex",
            filePanel?.open && sessionId && "lg:hidden 2xl:flex",
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
                controls={controls}
                onChanged={() => {
                  void sessions.refetch();
                }}
                onDeleted={(id) => {
                  if (id === sessionId) select(computerId);
                }}
              />
            )}
          </div>
        </section>
        {sessionId ? (
          <PiChatConversation
            key={key}
            computerId={computerId}
            controls={controls}
            userId={props.userId}
            workspaceId={props.workspaceId}
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
        {filePanel?.open && sessionId && (
          <PiChatFilesPanel
            key={computerId}
            computerId={computerId}
            computerName={computer?.name ?? computerId}
            workspaceSlug={workspaceSlug}
            supported={computer?.files ?? false}
            path={filePanel.path}
            onPath={openFiles}
            onMention={(path) =>
              setDrafts((current) => {
                const draft = current[key] ?? { text: "" };
                return {
                  ...current,
                  [key]: {
                    ...draft,
                    text: [draft.text, `@${JSON.stringify(path)}`].filter(Boolean).join(" "),
                    request: undefined,
                  },
                };
              })
            }
            onClose={() =>
              setFilePanels((current) => ({
                ...current,
                [computerId]: { ...current[computerId]!, open: false },
              }))
            }
          />
        )}
      </main>
    </PiChatFilesContext>
  );
}
