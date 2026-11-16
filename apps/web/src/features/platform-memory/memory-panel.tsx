import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Select } from "#src/components/base/select/select";
import { SettingsPage } from "#src/components/settings-layout";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useWorkspaceExperiments } from "#src/features/settings/experiments-settings";
import { setExperiment } from "#src/features/settings/experiments.functions";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type {
  MemoryKind,
  MemoryScope,
  PlatformMemoryCommand,
  PlatformMemoryEntry,
} from "@lrm/coforge-sdk/agent";
import { managePlatformMemory, platformMemoryAgents } from "./platform-memory.functions";

export function MemorySettings() {
  const workspaceId = useCurrentWorkspaceId();
  return <MemorySettingsPanel key={workspaceId} />;
}
function MemorySettingsPanel() {
  const call = useServerFn(managePlatformMemory);
  const loadAgents = useServerFn(platformMemoryAgents);
  const set = useServerFn(setExperiment);
  const workspaceId = useCurrentWorkspaceId();
  const cache = useQueryClient();
  const experiments = useWorkspaceExperiments();
  const [scope, setScope] = useState<MemoryScope>("team");
  const [agentId, setAgentId] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<PlatformMemoryEntry | "new" | null>(null);
  const [deleting, setDeleting] = useState<PlatformMemoryEntry | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const key = ["platform-memory", workspaceId];
  const status = useQuery({
    queryKey: [...key, "status"],
    queryFn: () => call({ data: { operation: "status" } }),
  });
  const agents = useQuery({ queryKey: [...key, "agents"], queryFn: () => loadAgents() });
  const selectedAgent = agentId || agents.data?.[0]?.id;
  const entries = useQuery({
    queryKey: [...key, scope, selectedAgent, search, page],
    enabled: Boolean(
      status.data?.enabled && status.data.available && (scope === "team" || selectedAgent),
    ),
    queryFn: () =>
      call({
        data: search
          ? {
              operation: "search",
              query: search,
              scope,
              ...(scope === "agent" ? { agentId: selectedAgent } : {}),
            }
          : {
              operation: "list",
              scope,
              page,
              ...(scope === "agent" ? { agentId: selectedAgent } : {}),
            },
      }),
  });
  async function mutate(command: PlatformMemoryCommand) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await call({ data: command });
      setNotice(result.cleanupPending ? m.memory_cleanup_pending() : m.memory_saved());
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (cause) {
      setError(isAppErrorCode(cause, "CONFLICT") ? m.memory_conflict() : m.memory_error());
      return false;
    } finally {
      setPending(false);
    }
  }
  function edit(entry: PlatformMemoryEntry | "new") {
    setEditing(entry);
    setError("");
    setTitle(entry === "new" ? "" : entry.title);
    setContent(entry === "new" ? "" : entry.content);
    setKind(entry === "new" ? "fact" : entry.kind);
  }
  const kindItems = [
    { id: "fact", label: m.memory_fact() },
    { id: "experience", label: m.memory_experience() },
    { id: "preference", label: m.memory_preference() },
  ];
  return (
    <SettingsPage>
      <div className="flex max-w-3xl flex-col gap-6">
        <p className="text-sm text-tertiary">{m.memory_description()}</p>
        {status.isPending ? (
          <p role="status">{m.memory_loading()}</p>
        ) : status.isError ? (
          <p role="alert" className="text-sm text-error-primary">
            {m.memory_error()}
          </p>
        ) : !status.data.enabled ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-secondary">{m.memory_disabled()}</p>
            {experiments.data?.canManage ? (
              <Button
                isDisabled={pending}
                onClick={async () => {
                  setPending(true);
                  setError("");
                  try {
                    await set({ data: { key: "platformMemory", enabled: true } });
                    await cache.invalidateQueries({ queryKey: key });
                    await cache.invalidateQueries({ queryKey: ["settings-experiments"] });
                  } catch {
                    setError(m.memory_error());
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {m.memory_enable()}
              </Button>
            ) : null}
          </div>
        ) : !status.data.available ? (
          <div className="flex flex-col items-start gap-3">
            <p role="status" className="text-sm text-secondary">
              {m.memory_unavailable()}
            </p>
            <Button color="secondary" onClick={() => void status.refetch()}>
              {m.memory_retry()}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                color={scope === "team" ? "primary" : "secondary"}
                onClick={() => {
                  setScope("team");
                  setEditing(null);
                  setPage(1);
                }}
              >
                {m.memory_team()}
              </Button>
              <Button
                color={scope === "agent" ? "primary" : "secondary"}
                onClick={() => {
                  setScope("agent");
                  setEditing(null);
                  setPage(1);
                }}
              >
                {m.memory_personal()}
              </Button>
            </div>
            {scope === "agent" ? (
              agents.data?.length ? (
                <Select
                  label={m.memory_agent()}
                  selectedKey={selectedAgent}
                  onSelectionChange={(key) => {
                    setAgentId(String(key));
                    setEditing(null);
                    setPage(1);
                  }}
                  items={agents.data.map((a) => ({ id: a.id, label: a.displayName || a.name }))}
                >
                  {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
              ) : (
                <p className="text-sm text-secondary">{m.memory_no_agents()}</p>
              )
            ) : null}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(query.trim());
                setPage(1);
              }}
            >
              <Input
                label={m.memory_search()}
                value={query}
                onChange={setQuery}
                className="min-w-0 flex-1"
              />
              <Button type="submit" color="secondary">
                {m.memory_search()}
              </Button>
            </form>
            {editing ? (
              <form
                className="flex flex-col gap-4 border-y border-secondary py-5"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const payload = { title, content, kind, requestId: crypto.randomUUID() };
                  const saved = await mutate(
                    editing === "new"
                      ? {
                          operation: "create",
                          scope,
                          ...(scope === "agent" ? { agentId: selectedAgent } : {}),
                          ...payload,
                        }
                      : {
                          operation: "update",
                          id: editing.id,
                          revision: editing.revision,
                          ...payload,
                        },
                  );
                  if (saved) setEditing(null);
                }}
              >
                <Input
                  label={m.memory_title()}
                  value={title}
                  onChange={setTitle}
                  maxLength={160}
                  isRequired
                />
                <Select
                  label={m.memory_kind()}
                  selectedKey={kind}
                  onSelectionChange={(key) => setKind(String(key) as MemoryKind)}
                  items={kindItems}
                >
                  {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <TextArea
                  label={m.memory_content()}
                  value={content}
                  onChange={setContent}
                  maxLength={16000}
                  rows={6}
                  isRequired
                />
                <div className="flex gap-2">
                  <Button type="submit" isDisabled={pending}>
                    {m.memory_save()}
                  </Button>
                  <Button color="secondary" isDisabled={pending} onClick={() => setEditing(null)}>
                    {m.memory_cancel()}
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                className="self-start"
                isDisabled={scope === "agent" && !selectedAgent}
                onClick={() => edit("new")}
              >
                {m.memory_add()}
              </Button>
            )}
            {entries.isFetching ? (
              <p role="status" className="text-sm text-secondary">
                {m.memory_loading()}
              </p>
            ) : entries.isError ? (
              <p role="alert" className="text-sm text-error-primary">
                {m.memory_error()}
              </p>
            ) : !entries.data?.entries.length ? (
              <p className="py-6 text-sm text-secondary">
                {search ? m.memory_no_matches() : m.memory_empty()}
              </p>
            ) : (
              <ul className="divide-y divide-secondary">
                {entries.data.entries.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-3 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="min-w-0 break-words text-md font-semibold text-primary">
                        {entry.title}
                      </h3>
                      <span className="text-sm text-tertiary">
                        {kindItems.find((k) => k.id === entry.kind)?.label}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-secondary">
                      {entry.content}
                    </p>
                    {entry.sourceMessageId ? (
                      <p className="break-all text-sm text-tertiary">
                        {m.memory_source()}: {entry.sourceMessageId}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        color="secondary"
                        size="sm"
                        isDisabled={pending || entry.canEdit === false}
                        onClick={() => edit(entry)}
                      >
                        {m.memory_edit()}
                      </Button>
                      {entry.scope === "agent" ? (
                        <Button
                          color="secondary"
                          size="sm"
                          isDisabled={pending}
                          onClick={() =>
                            void mutate({
                              operation: "share",
                              id: entry.id,
                              revision: entry.revision,
                              requestId: crypto.randomUUID(),
                            })
                          }
                        >
                          {m.memory_share()}
                        </Button>
                      ) : null}
                      <Button
                        color="secondary-destructive"
                        size="sm"
                        isDisabled={pending || entry.canEdit === false}
                        onClick={() => setDeleting(entry)}
                      >
                        {m.memory_delete()}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!search && entries.data && (entries.data.pageCount ?? 0) > 1 ? (
              <div className="flex gap-2">
                <Button
                  color="secondary"
                  isDisabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {m.memory_previous()}
                </Button>
                <Button
                  color="secondary"
                  isDisabled={page >= (entries.data.pageCount ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {m.memory_next()}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-secondary">
            {notice}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={m.memory_delete()}
        description={m.memory_delete_description()}
        confirmLabel={m.memory_delete()}
        errorMessage={m.memory_error()}
        onConfirm={async () => {
          if (
            deleting &&
            !(await mutate({
              operation: "delete",
              id: deleting.id,
              revision: deleting.revision,
              requestId: crypto.randomUUID(),
            }))
          )
            throw new Error("delete refused");
        }}
      />
    </SettingsPage>
  );
}
