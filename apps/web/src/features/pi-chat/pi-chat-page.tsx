import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, Plus, SearchLg } from "@untitledui/icons";
import type { WorkbenchRuntime } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { ChatWireframe, ComputersWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { markAiWorkbenchOff, useAiWorkbenchEnabled } from "#src/features/settings/ai-workbench";
import { isAppErrorCode } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { piChatFailureMessage } from "./pi-chat-failure";
import { getPiChatComputers } from "./pi-chat.functions";
import { useExecutePiChat } from "./use-execute-pi-chat";
import { PiChatFilesContext } from "./pi-chat-files-context";
import { PiChatFilesPanel } from "./pi-chat-files-panel";
import { PiChatSessionList } from "./pi-chat-session-list";
import { createPiChatDrafts } from "./pi-chat-drafts";
import type { PiChatView } from "./pi-chat-state";
import { PiChatConversation } from "./pi-chat-conversation";
import { PiChatOff } from "./pi-chat-off";
import { WorkbenchStart, type WorkbenchComputer } from "./workbench-start";

type Props = {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  computers: WorkbenchComputer[];
  configured: boolean;
  computerId?: string;
  sessionId?: string;
  runtime?: WorkbenchRuntime;
  select(computerId: string, sessionId?: string, runtime?: WorkbenchRuntime): void;
};

export function PiChatPage(props: Props) {
  return useAiWorkbenchEnabled() ? <PiChatContent {...props} /> : <PiChatOff />;
}

function PiChatContent(props: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceSlug, configured, sessionId, select, runtime } = props;
  const getComputers = useServerFn(getPiChatComputers);
  const capabilities = useQuery({
    queryKey: ["pi-chat", workspaceSlug, props.userId, "computers"],
    queryFn: () =>
      getComputers().catch((error: unknown) => {
        if (isAppErrorCode(error, "ACCESS_DENIED")) markAiWorkbenchOff(queryClient);
        throw error;
      }),
    refetchInterval: 10_000,
    enabled: configured,
    retry: false,
  });
  const computers = capabilities.data?.computers ?? props.computers;
  const computer = computers.find((entry) => entry.id === props.computerId) ?? computers[0];
  const computerId = computer?.id;
  const controls = computer?.controls ?? false;
  const [filePanels, setFilePanels] = useState<Record<string, { open: boolean; path?: string }>>(
    {},
  );
  const filePanel = filePanels[computerId ?? ""];
  const openFiles = useCallback(
    (path?: string) =>
      setFilePanels((current) => ({ ...current, [computerId!]: { open: true, path } })),
    [computerId],
  );
  const filesSupported = computer?.files ?? false;
  const files = useMemo(
    () => ({ supported: filesSupported, open: openFiles }),
    [filesSupported, openFiles],
  );
  const [search, setSearch] = useState("");
  const [drafts] = useState(createPiChatDrafts);
  const key = `${workspaceSlug}:${computerId}:${sessionId ?? "new"}:${runtime ?? RUNTIME_PROVIDER.PI}`;
  const execute = useExecutePiChat();
  const sessions = useQuery({
    queryKey: ["pi-chat", workspaceSlug, computerId, "sessions"],
    queryFn: () =>
      execute({
        data: {
          computerId: computerId!,
          command: {
            action: "list",
            ...(computer?.pi === false
              ? { runtime: RUNTIME_PROVIDER.CODEX }
              : { includeCodex: true }),
          },
        },
      }),
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
  if (!configured || !computerId || !computer)
    return (
      <main className="flex h-full min-h-0 flex-col bg-primary">
        <PageHeader heading={m.pi_chat_title()} />
        <EmptyState
          picture={<ComputersWireframe accent={configured} />}
          title={configured ? m.empty_pi_chat_no_computer_title() : m.pi_chat_unconfigured()}
          description={configured ? m.pi_chat_no_computer_hint() : m.pi_chat_unconfigured_hint()}
          primaryAction={
            configured ? (
              <Button
                size="sm"
                color="primary"
                onPress={() =>
                  void navigate({ to: "/w/$workspaceSlug/computers", params: { workspaceSlug } })
                }
              >
                {m.navigation_computers()}
              </Button>
            ) : undefined
          }
        />
      </main>
    );
  const initialSession = sessions.data?.sessions?.find((session) => session.id === sessionId);
  const sessionRuntime =
    computer.pi === false ? RUNTIME_PROVIDER.CODEX : (initialSession?.runtime ?? runtime);
  return (
    <PiChatFilesContext value={files}>
      <main className="flex h-full min-h-0 min-w-0 overflow-hidden bg-primary">
        <section
          aria-label={m.pi_chat_sessions()}
          className={cn(
            "w-full min-w-0 flex-col lg:flex lg:w-[18rem] lg:shrink-0 lg:border-r lg:border-secondary",
            sessionId ? (filePanel?.open ? "hidden lg:flex" : "hidden") : "flex",
            filePanel?.open && sessionId && "max-lg:hidden lg:flex",
          )}
        >
          <PageHeader
            heading={m.pi_chat_title()}
            actions={
              <ButtonUtility
                size="sm"
                color="secondary"
                icon={Plus}
                tooltip={m.pi_chat_new()}
                onClick={() =>
                  select(computerId, "new", computer.codex ? undefined : RUNTIME_PROVIDER.PI)
                }
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
              icon={SearchLg}
              placeholder={m.pi_chat_search()}
              value={search}
              onChange={setSearch}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {sessions.isPending && (
              <div
                role="status"
                aria-busy="true"
                aria-label={m.pi_chat_loading()}
                className="space-y-2 p-2"
              >
                <Skeleton className="h-11 w-full rounded-lg" />
                <Skeleton className="h-11 w-full rounded-lg" />
                <Skeleton className="h-11 w-5/6 rounded-lg" />
              </div>
            )}
            {sessions.isError && (
              <div className="p-2">
                <EmptyState
                  size="card"
                  role="alert"
                  picture={<EmptyIcon icon={AlertCircle} size="card" />}
                  title={piChatFailureMessage("load")}
                  primaryAction={
                    <RetryButton
                      size="card"
                      isRetrying={sessions.isRefetching}
                      label={m.pi_chat_retry()}
                      onPress={() => void sessions.refetch()}
                    />
                  }
                />
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
        {sessionId === "new" && !runtime && computer.codex ? (
          <WorkbenchStart
            key={computerId}
            computers={computers}
            computer={computer}
            onComputer={(id) => select(id, "new")}
            onStart={(provider) => select(computerId, "new", provider)}
            onBack={() => select(computerId)}
          />
        ) : sessionId ? (
          <PiChatConversation
            key={key}
            computerId={computerId}
            controls={controls}
            userId={props.userId}
            workspaceId={props.workspaceId}
            sessionId={sessionId}
            runtime={sessionRuntime}
            workspaceSlug={workspaceSlug}
            viewport={viewports.current.get(key)!}
            initialSession={initialSession}
            drafts={drafts}
            draftKey={key}
            onSelect={(id) => {
              if (selection.current === key)
                select(computerId, id, id ? sessionRuntime : undefined);
            }}
            onRecover={(text) => {
              drafts.set(`${workspaceSlug}:${computerId}:new:codex`, { text });
              select(computerId, "new", RUNTIME_PROVIDER.CODEX);
            }}
          />
        ) : (
          <section className="hidden min-w-0 flex-1 lg:flex">
            <EmptyState
              picture={<ChatWireframe accent />}
              title={m.empty_pi_chat_none_selected_title()}
              description={m.empty_pi_chat_none_selected_description()}
              primaryAction={
                <Button
                  size="sm"
                  color="primary"
                  iconLeading={Plus}
                  onPress={() =>
                    select(computerId, "new", computer.codex ? undefined : RUNTIME_PROVIDER.PI)
                  }
                >
                  {m.pi_chat_new()}
                </Button>
              }
            />
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
              drafts.update(key, (draft) => ({
                ...draft,
                text: [draft.text, `@${JSON.stringify(path)}`].filter(Boolean).join(" "),
                request: undefined,
              }))
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
