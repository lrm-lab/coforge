import { PersonalMemoryRecord } from "./personal-memory-record";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "@untitledui/icons";
import type { LocalMemoryEntry } from "@lrm/coforge-sdk/agent";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import * as m from "#src/paraglide/messages";
import {
  PersonalMemoryEditor,
  personalMemoryDraft as initial,
  type PersonalMemoryDraft as Draft,
} from "./personal-memory-editor";
import { PersonalMemoryHistoryPanel } from "./personal-memory-history-panel";
import { personalResponseError as responseError } from "./personal-memory-response";
import {
  PersonalMemoryAgentsEmpty,
  PersonalMemoryDetailEmpty,
  PersonalMemoryErrorState,
  PersonalMemoryListEmpty,
} from "./personal-memory-states";
import { MemoryScopeLinks } from "./memory-scope-links";
import { listMyMemoryAgents, personalMemoryCommand } from "./personal-memory.functions";

export type PersonalSearch = {
  agent?: string;
  create: boolean;
  key?: string;
  q: string;
  archived: boolean;
  offset: number;
  agentQuery: string;
  page: number;
};
type Response = Awaited<ReturnType<typeof personalMemoryCommand>>;
export function PersonalMemoryPage({
  search,
  agents,
  list,
  detail,
}: {
  search: PersonalSearch;
  agents: Awaited<ReturnType<typeof listMyMemoryAgents>>;
  list?: Response;
  detail?: Response;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate({ from: "/w/$workspaceSlug/memory/personal" });
  const router = useRouter();
  const [agentQuery, setAgentQuery] = useState(search.agentQuery);
  const [query, setQuery] = useState(search.q);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<LocalMemoryEntry[]>();
  const [historyOffset, setHistoryOffset] = useState<number>();
  const [historical, setHistorical] = useState<LocalMemoryEntry>();
  const selected = search.create ? "<create>" : search.key;
  const stamp = useMemo(() => ({}), [workspaceSlug, search.agent, selected]);
  const historicalRequest = useRef(0);
  const active = useRef(stamp);
  active.current = stamp;
  useEffect(() => {
    historicalRequest.current++;
    setBusy(false);
    setError("");
    setHistory(undefined);
    setHistorical(undefined);
    setEditing(false);
  }, [stamp]);
  useEffect(() => {
    setQuery(search.q);
  }, [search.q]);
  useEffect(() => {
    setAgentQuery(search.agentQuery);
  }, [search.agentQuery]);
  const agentItems =
    agents.selected && !agents.agents.some((agent) => agent.id === agents.selected?.id)
      ? [agents.selected, ...agents.agents]
      : agents.agents;
  const entry =
    detail?.status === "ready" && detail.result.status === "ok"
      ? detail.result.result.entries[0]
      : undefined;
  const entries =
    list?.status === "ready" && list.result.status === "ok" ? list.result.result.entries : [];
  const next =
    list?.status === "ready" && list.result.status === "ok"
      ? list.result.result.nextOffset
      : undefined;
  const cacheKey = `${workspaceSlug}:${search.agent}:${selected ?? "new"}`;
  const draft = drafts[cacheKey] ?? initial(entry);
  const patch = (patch: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [cacheKey]: { ...draft, ...patch } }));
  const update = (patch: Partial<PersonalSearch>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }) });
  const changed = async (entry?: LocalMemoryEntry) => {
    if (active.current !== stamp) {
      await router.invalidate({ sync: true });
      return;
    }
    setEditing(false);
    setHistory(undefined);
    setHistorical(undefined);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[cacheKey];
      return next;
    });
    if (entry) await update({ key: entry.key, create: false });
    await router.invalidate({ sync: true });
  };
  const isEditing = search.create || editing;
  const loadHistory = async (offset = 0) => {
    if (!search.agent || !entry) return;
    setBusy(true);
    setError("");
    try {
      const result = await personalMemoryCommand({
        data: { agentId: search.agent, command: { operation: "history", key: entry.key, offset } },
      });
      if (active.current !== stamp) return;
      const failure = responseError(result);
      if (failure) setError(failure);
      else if (result.status === "ready" && result.result.status === "ok") {
        setHistory(result.result.result.entries);
        setHistoryOffset(result.result.result.nextOffset);
      }
    } catch {
      if (active.current === stamp) setError(m.memory_failed());
    } finally {
      if (active.current === stamp) setBusy(false);
    }
  };
  return (
    <main className="flex h-full min-h-0 flex-col bg-primary">
      <header className="flex items-center justify-between gap-4 border-b border-secondary px-5 py-4 lg:px-8">
        <h1 className="text-lg font-semibold text-primary">{m.memory_personal()}</h1>
        <Button
          size="sm"
          iconLeading={Plus}
          isDisabled={!search.agent || busy || !!(list && responseError(list))}
          onPress={() => {
            setEditing(false);
            void update({ key: undefined, create: true });
          }}
        >
          {m.memory_new()}
        </Button>
      </header>
      <MemoryScopeLinks />
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
        <section
          className={`${selected ? "hidden lg:flex" : "flex"} min-h-0 flex-col border-secondary lg:border-r`}
        >
          <div className="flex flex-col gap-3 border-b border-secondary px-5 py-4">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void update({ agentQuery: agentQuery.trim(), page: 1 });
              }}
            >
              <Input
                label={m.memory_agent_search()}
                value={agentQuery}
                onChange={setAgentQuery}
                maxLength={100}
                isDisabled={busy}
              />
              <div className="mt-3">
                <Button color="secondary" size="sm" type="submit">
                  {m.memory_search()}
                </Button>
              </div>
            </form>
            <Select
              label={m.memory_agent()}
              selectedKey={search.agent ?? null}
              isDisabled={busy}
              onSelectionChange={(key) => {
                if (key) {
                  setEditing(false);
                  setHistory(undefined);
                  setHistorical(undefined);
                  setError("");
                  void update({ agent: String(key), key: undefined, create: false, offset: 0 });
                }
              }}
            >
              {agentItems.map((agent) => (
                <Select.Item key={agent.id} id={agent.id} label={agent.displayName || agent.name} />
              ))}
            </Select>
            {!agents.agents.length && (
              <PersonalMemoryAgentsEmpty
                agentQuery={search.agentQuery}
                onClear={() => void update({ agentQuery: "", page: 1 })}
              />
            )}
            <div className="flex gap-3">
              {search.page > 1 && (
                <Button
                  color="secondary"
                  size="sm"
                  onPress={() => update({ page: search.page - 1 })}
                >
                  {m.memory_previous()}
                </Button>
              )}
              {agents.hasNextPage && (
                <Button
                  color="secondary"
                  size="sm"
                  onPress={() => update({ page: search.page + 1 })}
                >
                  {m.memory_next()}
                </Button>
              )}
            </div>
            {search.agent && (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void update({ q: query.trim(), offset: 0 });
                  }}
                >
                  <Input
                    label={m.memory_search()}
                    value={query}
                    onChange={setQuery}
                    maxLength={500}
                  />
                  <div className="mt-3">
                    <Button type="submit" color="secondary" size="sm">
                      {m.memory_search()}
                    </Button>
                  </div>
                </form>
                <Select
                  aria-label={m.memory_current()}
                  selectedKey={search.archived ? "archived" : "active"}
                  onSelectionChange={(key) => {
                    void update({ archived: key === "archived", q: "", offset: 0, key: undefined });
                  }}
                >
                  <Select.Item id="active" label={m.memory_active()} />
                  <Select.Item id="archived" label={m.memory_archived()} />
                </Select>
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list && responseError(list) && (
              <div className="p-4">
                <PersonalMemoryErrorState
                  message={responseError(list)!}
                  onRetry={() => void router.invalidate({ sync: true })}
                />
              </div>
            )}
            {list && !responseError(list) && !entries.length && next === undefined && (
              <PersonalMemoryListEmpty
                query={search.q}
                archived={search.archived}
                agentName={agents.selected?.displayName || agents.selected?.name || ""}
                onClear={() => void update({ q: "", archived: false, offset: 0 })}
                onCreate={() => {
                  setEditing(false);
                  void update({ key: undefined, create: true });
                }}
              />
            )}
            <ul className="divide-y divide-secondary">
              {entries.map((item) => (
                <li key={item.key}>
                  {/^[a-z0-9][a-z0-9_-]*$/.test(item.key) ? (
                    <Link
                      to="/w/$workspaceSlug/memory/personal"
                      params={{ workspaceSlug }}
                      search={{ ...search, key: item.key, create: false }}
                      className="block cursor-pointer px-5 py-4 hover:bg-primary_hover"
                      aria-current={selected === item.key ? "true" : undefined}
                    >
                      <p className="break-words text-sm font-semibold text-primary">{item.title}</p>
                      <p className="mt-1 line-clamp-2 break-words text-sm text-tertiary">
                        {item.content}
                      </p>
                    </Link>
                  ) : (
                    <div className="px-5 py-4">
                      <p className="break-words text-sm font-semibold text-primary">{item.title}</p>
                      <p className="mt-1 break-words text-sm text-tertiary">{item.content}</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex gap-3 px-5 py-4">
              {search.offset > 0 && (
                <Button
                  color="secondary"
                  size="sm"
                  onPress={() =>
                    update({ offset: Math.max(0, search.offset - (search.q ? 128 : 5)) })
                  }
                >
                  {m.memory_previous()}
                </Button>
              )}
              {next !== undefined && (
                <Button color="secondary" size="sm" onPress={() => update({ offset: next })}>
                  {m.memory_next()}
                </Button>
              )}
            </div>
          </div>
        </section>
        <section
          className={`${selected ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col gap-5 overflow-y-auto px-5 py-5 lg:px-8`}
        >
          {selected && (
            <div className="lg:hidden">
              <Button
                color="link-gray"
                size="sm"
                iconLeading={ArrowLeft}
                onPress={() => update({ key: undefined, create: false })}
              >
                {m.memory_back()}
              </Button>
            </div>
          )}
          {(isEditing || entry) && (
            <p className="text-sm text-tertiary">{m.memory_private_help()}</p>
          )}
          {detail && responseError(detail) && (
            <PersonalMemoryErrorState
              size="page"
              message={responseError(detail)!}
              onRetry={() => void router.invalidate({ sync: true })}
            />
          )}
          {!isEditing && !entry && !(detail && responseError(detail)) && (
            <PersonalMemoryDetailEmpty
              hasAgents={agentItems.length > 0 || Boolean(search.agent)}
              hasAgentSelected={Boolean(search.agent)}
            />
          )}
          {isEditing && search.agent && (search.create || entry) ? (
            <PersonalMemoryEditor
              key={cacheKey}
              agentId={search.agent}
              entry={entry}
              draft={draft}
              onChange={patch}
              onSaved={changed}
              current={() => active.current === stamp}
              onCancel={() => {
                setEditing(false);
                if (search.create) void update({ key: undefined, create: false });
              }}
            />
          ) : (
            entry && (
              <>
                <PersonalMemoryRecord entry={entry} />
                <div className="flex flex-wrap gap-3">
                  <Button
                    color="secondary"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => setEditing(true)}
                  >
                    {entry.status === "archived" ? m.memory_restore() : m.memory_edit()}
                  </Button>
                  <Button
                    color="secondary"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => loadHistory()}
                  >
                    {m.memory_history()}
                  </Button>
                  <Button
                    color="secondary"
                    size="sm"
                    isDisabled={busy || entry.status === "archived"}
                    onPress={async () => {
                      if (!search.agent) return;
                      setBusy(true);
                      setError("");
                      try {
                        const result = await personalMemoryCommand({
                          data: {
                            agentId: search.agent,
                            command: {
                              operation: "archive",
                              key: entry.key,
                              revision: entry.revision,
                            },
                          },
                        });
                        if (active.current !== stamp) return;
                        const failure = responseError(result);
                        if (failure) setError(failure);
                        else await changed();
                      } catch {
                        if (active.current === stamp) setError(m.memory_failed());
                      } finally {
                        if (active.current === stamp) setBusy(false);
                      }
                    }}
                  >
                    {m.memory_archive()}
                  </Button>
                </div>
                <PersonalMemoryHistoryPanel
                  history={history}
                  historyOffset={historyOffset}
                  historical={historical}
                  busy={busy}
                  onLoadMore={(offset) => void loadHistory(offset)}
                  onSelectVersion={async (revision) => {
                    if (!search.agent) return;
                    const requestId = ++historicalRequest.current;
                    setBusy(true);
                    try {
                      const result = await personalMemoryCommand({
                        data: {
                          agentId: search.agent,
                          command: { operation: "get", key: entry.key, revision },
                        },
                      });
                      if (active.current !== stamp || historicalRequest.current !== requestId)
                        return;
                      const failure = responseError(result);
                      if (failure) setError(failure);
                      else if (result.status === "ready" && result.result.status === "ok")
                        setHistorical(result.result.result.entries[0]);
                    } catch {
                      if (active.current === stamp && historicalRequest.current === requestId)
                        setError(m.memory_failed());
                    } finally {
                      if (historicalRequest.current === requestId) setBusy(false);
                    }
                  }}
                  onRestoreVersion={(selectedVersion) => {
                    setDrafts((previous) => ({
                      ...previous,
                      [cacheKey]: {
                        ...initial(selectedVersion),
                        revision: entry.revision,
                        restoring: true,
                      },
                    }));
                    setEditing(true);
                  }}
                />
              </>
            )
          )}
          {error && (
            <PersonalMemoryErrorState
              message={error}
              onRetry={() => void router.invalidate({ sync: true })}
            />
          )}
        </section>
      </div>
    </main>
  );
}
