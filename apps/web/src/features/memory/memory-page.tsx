import { MemoryScopeLinks } from "./memory-scope-links";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import type { TeamMemoryHead } from "@lrm/coforge-sdk/agent";
import * as m from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { memoryCommand } from "./memory.functions";
import { memoryError, memoryKind } from "./memory-copy";
import { MemoryEditor, memoryDraft, type MemoryDraft } from "./memory-editor";
import { MemoryHistory } from "./memory-history";
import { MemoryProjectPicker } from "./memory-project-picker";
import { MemoryProvenance } from "./memory-provenance";
import type { TeamMemoryDecisionGraph } from "#src/server/db/repositories/team-memory-decision-graph.server";
import { MemoryDecisionGraph } from "./memory-decision-graph";

export type MemorySearch = {
  q: string;
  archived: boolean;
  offset: number;
  project?: string;
  id?: string;
  review?: boolean;
  after?: string;
};
type Response = Awaited<ReturnType<typeof memoryCommand>>;
export function MemoryPage({
  search,
  list,
  detail,
  graph,
}: {
  search: MemorySearch;
  list: Response;
  detail?: Response;
  graph?: TeamMemoryDecisionGraph;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate({ from: "/w/$workspaceSlug/memory" });
  const router = useRouter();
  const [query, setQuery] = useState(search.q);
  const [drafts, setDrafts] = useState<Record<string, MemoryDraft>>({});
  const [editing, setEditing] = useState<string>();
  const entry = detail?.kind === "ready" ? detail.result.entries[0] : undefined;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [destructive, setDestructive] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const selected = search.id;
  const selection = useMemo(() => ({}), [selected, workspaceSlug]);
  const activeSelection = useRef(selection);
  activeSelection.current = selection;
  useEffect(() => {
    setError("");
    setDestructive(false);
    setConfirmation("");
    setReason("");
  }, [selected]);
  useEffect(() => {
    setQuery(search.q);
  }, [search.q]);
  const isEditing = selected === "new" || (!!selected && editing === selected);
  const key = `${workspaceSlug}:${selected ?? "new"}`;
  const draft = drafts[key] ?? memoryDraft(entry);
  const names = detail?.kind === "ready" ? detail.names : {};
  const updateSearch = (patch: Partial<MemorySearch>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }) });
  const refresh = () => router.invalidate({ sync: true });
  const saved = async (savedEntry: TeamMemoryHead) => {
    if (activeSelection.current !== selection) {
      await refresh();
      return;
    }
    setEditing(undefined);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    await updateSearch({ id: savedEntry.id });
    await refresh();
  };
  const mutate = async (operation: "archive" | "delete" | "restore") => {
    if (!entry) return;
    setBusy(true);
    setError("");
    try {
      const target = {
        id: entry.id,
        revision: entry.revision,
        requestId: crypto.randomUUID(),
        reason,
      };
      const result = await memoryCommand({
        data:
          operation === "restore"
            ? { operation, ...target, fromRevision: entry.revision }
            : { operation, ...target },
      });
      if (activeSelection.current !== selection) {
        if (result.kind === "ready") await refresh();
        return;
      }
      if (result.kind === "error") setError(memoryError(result.error));
      else {
        setDestructive(false);
        setConfirmation("");
        setReason("");
        if (operation === "delete") await updateSearch({ id: undefined });
        await refresh();
      }
    } catch {
      if (activeSelection.current === selection) setError(m.memory_failed());
    } finally {
      setBusy(false);
    }
  };
  const sectionClass = "flex min-h-0 min-w-0 flex-col";
  return (
    <main className="flex h-full min-h-0 flex-col bg-primary">
      <header className="flex items-center justify-between gap-4 border-b border-secondary px-5 py-4 lg:px-8">
        <h1 className="text-lg font-semibold text-primary">{m.memory_title()}</h1>
        <Button
          size="sm"
          iconLeading={Plus}
          isDisabled={list.kind === "error"}
          onPress={() => updateSearch({ id: "new" })}
        >
          {m.memory_new()}
        </Button>
      </header>
      <MemoryScopeLinks showReview={list.reviewEnabled && list.kind === "ready"} />
      {list.kind === "error" ? (
        <p role="alert" className="px-5 py-8 text-sm text-error-primary">
          {memoryError(list.error)}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <section
            aria-label={m.memory_title()}
            className={`${sectionClass} ${selected ? "hidden lg:flex" : "flex"} border-secondary lg:border-r`}
          >
            <div className="flex flex-col gap-3 border-b border-secondary px-5 py-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void updateSearch({ q: query.trim(), offset: 0 });
                }}
              >
                <Input
                  label={m.memory_search()}
                  value={query}
                  onChange={setQuery}
                  maxLength={500}
                />
                <div className="mt-3">
                  <Button color="secondary" size="sm" type="submit">
                    {m.memory_search()}
                  </Button>
                </div>
              </form>
              <Select
                aria-label={m.memory_current()}
                selectedKey={search.archived ? "archived" : "active"}
                onSelectionChange={(value) => {
                  if (value)
                    void updateSearch({ archived: value === "archived", offset: 0, id: undefined });
                }}
              >
                <Select.Item id="active" label={m.memory_active()} />
                <Select.Item id="archived" label={m.memory_archived()} />
              </Select>
              <MemoryProjectPicker
                emptyLabel={m.memory_all_projects()}
                value={search.project ?? null}
                onChange={(project) => {
                  void updateSearch({ project: project ?? undefined, offset: 0, id: undefined });
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!list.result.entries.length && (
                <p className="px-5 py-8 text-sm text-tertiary">{m.memory_empty()}</p>
              )}
              <ul className="divide-y divide-secondary">
                {list.result.entries.map((item) => (
                  <li key={item.id}>
                    <Link
                      to="/w/$workspaceSlug/memory"
                      params={{ workspaceSlug }}
                      search={{ ...search, id: item.id }}
                      className={`block cursor-pointer px-5 py-4 hover:bg-primary_hover ${selected === item.id ? "bg-active" : ""}`}
                      aria-current={selected === item.id ? "true" : undefined}
                    >
                      <p className="break-words text-sm font-semibold text-primary">{item.title}</p>
                      <p className="mt-1 line-clamp-2 break-words text-sm text-tertiary">
                        {item.content}
                      </p>
                      <p className="mt-2 text-xs text-quaternary">
                        {memoryKind(item.kind)}
                        {item.projectId
                          ? ` · ${list.names[item.projectId] ?? m.memory_project()}`
                          : ""}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex gap-3 px-5 py-4">
                {search.offset > 0 && (
                  <Button
                    color="secondary"
                    size="sm"
                    onPress={() => updateSearch({ offset: Math.max(0, search.offset - 10) })}
                  >
                    {m.memory_previous()}
                  </Button>
                )}
                {list.result.nextOffset !== undefined && (
                  <Button
                    color="secondary"
                    size="sm"
                    onPress={() => updateSearch({ offset: list.result.nextOffset ?? 0 })}
                  >
                    {m.memory_next()}
                  </Button>
                )}
              </div>
            </div>
          </section>
          <section
            className={`${sectionClass} ${selected ? "flex" : "hidden lg:flex"} overflow-y-auto px-5 py-5 lg:px-8`}
          >
            {selected && (
              <div className="mb-5 lg:hidden">
                <Button
                  iconLeading={ArrowLeft}
                  color="link-gray"
                  size="sm"
                  onPress={() => updateSearch({ id: undefined })}
                >
                  {m.memory_back()}
                </Button>
              </div>
            )}
            {!selected && <p className="text-sm text-tertiary">{m.memory_choose()}</p>}
            {detail?.kind === "error" && (
              <p role="alert" className="text-sm text-error-primary">
                {memoryError(detail.error)}
              </p>
            )}
            {isEditing && (selected === "new" || entry) ? (
              <MemoryEditor
                key={key}
                entry={entry}
                draft={draft}
                projectName={names[draft.projectId ?? ""]}
                onChange={(draft) => setDrafts((previous) => ({ ...previous, [key]: draft }))}
                onSaved={saved}
                onSuggested={
                  list.reviewEnabled
                    ? () => {
                        if (activeSelection.current !== selection) return;
                        setEditing(undefined);
                        void updateSearch({ review: true, id: undefined, after: undefined });
                      }
                    : undefined
                }
                onCancel={() => {
                  setEditing(undefined);
                  if (selected === "new") void updateSearch({ id: undefined });
                }}
              />
            ) : (
              entry && (
                <div className="flex flex-col gap-5">
                  <h2 className="break-words text-lg font-semibold text-primary">{entry.title}</h2>
                  <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-5 text-sm">
                    <dt className="text-tertiary">{m.memory_content()}</dt>
                    <dd className="whitespace-pre-wrap break-words text-primary">
                      {entry.content}
                    </dd>
                    <dt className="text-tertiary">{m.memory_source()}</dt>
                    <dd className="whitespace-pre-wrap break-words text-primary">{entry.source}</dd>
                    <dt className="text-tertiary">{m.memory_applies()}</dt>
                    <dd className="whitespace-pre-wrap break-words text-primary">
                      {entry.applicability || "—"}
                    </dd>
                    <dt className="text-tertiary">{m.memory_project()}</dt>
                    <dd className="break-words text-primary">
                      {entry.projectId
                        ? (names[entry.projectId] ?? m.memory_no_project())
                        : m.memory_no_project()}
                    </dd>
                    <dt className="text-tertiary">{m.memory_author()}</dt>
                    <dd className="break-words text-primary">
                      {names[entry.authorUserId ?? entry.authorAgentId ?? ""] ?? m.memory_unknown()}
                    </dd>
                  </dl>
                  <MemoryDecisionGraph graph={graph} />
                  <MemoryProvenance
                    entry={entry}
                    links={detail?.kind === "ready" ? detail.evidenceLinks : undefined}
                  />
                  {entry.pinned && (
                    <p className="text-sm text-secondary">{m.memory_pinned_label()}</p>
                  )}
                  <p className="text-xs text-quaternary">
                    {m.memory_revision({ revision: entry.revision })}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      color="secondary"
                      size="sm"
                      onPress={() => {
                        setEditing(entry.id);
                        setError("");
                      }}
                    >
                      {m.memory_edit()}
                    </Button>
                    <Button
                      color="secondary"
                      size="sm"
                      onPress={async () => {
                        await refresh();
                      }}
                    >
                      {m.memory_reload()}
                    </Button>
                  </div>
                  <MemoryHistory
                    key={`${entry.id}:${entry.revision}`}
                    current={entry}
                    onChanged={refresh}
                  />
                  <section className="flex flex-col gap-3 border-t border-secondary pt-5">
                    <Input
                      label={m.memory_reason()}
                      value={reason}
                      onChange={setReason}
                      maxLength={1000}
                      isDisabled={busy}
                    />
                    <div className="flex flex-wrap gap-3">
                      <Button
                        color="secondary"
                        size="sm"
                        isDisabled={busy || !reason.trim()}
                        onPress={() => mutate(entry.status === "active" ? "archive" : "restore")}
                      >
                        {entry.status === "active" ? m.memory_archive() : m.memory_restore()}
                      </Button>
                      <Button
                        color="link-destructive"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => setDestructive(!destructive)}
                      >
                        {m.memory_delete()}
                      </Button>
                    </div>
                    {destructive && (
                      <>
                        <p className="text-sm text-error-primary">{m.memory_delete_help()}</p>
                        <Input
                          label={m.memory_name()}
                          value={confirmation}
                          onChange={setConfirmation}
                          isDisabled={busy}
                        />
                        <Button
                          color="primary-destructive"
                          size="sm"
                          isDisabled={busy || confirmation !== entry.title || !reason.trim()}
                          onPress={() => mutate("delete")}
                        >
                          {m.memory_delete()}
                        </Button>
                      </>
                    )}
                  </section>
                </div>
              )
            )}
            {error && (
              <p role="alert" className="mt-4 text-sm text-error-primary">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
