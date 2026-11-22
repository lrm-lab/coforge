import { ChevronRight, Folder } from "@untitledui/icons";
import {
  Button as AriaButton,
  Collection,
  Tree,
  TreeItem,
  TreeItemContent,
} from "react-aria-components";
import type { AgentWorkspaceFileEntry } from "@lrm/coforge-sdk/internal";

import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cn } from "#src/lib/utils";
import { PanelMessage } from "./panel-message";
import { AgentTabEmpty } from "./agent-tab-empty";
import { workspaceEntryTime } from "./agent-workspace-entry-time";

export type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: AgentWorkspaceFileEntry[]; rootPath?: string }
  | { status: "offline" | "timeout" | "unavailable" | "missing" | "unreadable" | "error" };

function joinPath(dirPath: string, name: string): string {
  return dirPath === "" ? name : `${dirPath}/${name}`;
}

export function TreeRoot({
  state,
  cache,
  expanded,
  selected,
  onExpandedChange,
  onSelectFile,
  onRetry,
}: {
  state: DirState | undefined;
  cache: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | undefined;
  onExpandedChange: (next: Set<string>) => void;
  onSelectFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (!state || state.status === "loading") {
    return (
      <div className="space-y-2 px-3 py-3" aria-busy="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={index}
            className="h-3 animate-pulse rounded bg-secondary motion-reduce:animate-none"
            style={{ width: `${70 - index * 8}%` }}
          />
        ))}
      </div>
    );
  }
  if (state.status === "offline") return <PanelMessage text={m.agent_workspace_offline()} />;
  if (state.status === "timeout")
    return <PanelMessage text={m.agent_workspace_timeout()} onRetry={onRetry} />;
  if (state.status !== "ready")
    return <PanelMessage text={m.agent_workspace_unavailable()} onRetry={onRetry} />;
  if (state.entries.length === 0)
    return (
      <AgentTabEmpty
        icon={Folder}
        title={m.agent_workspace_empty()}
        description={m.agent_workspace_empty_description()}
      />
    );

  return (
    <WorkspaceTree
      rootEntries={state.entries}
      cache={cache}
      expanded={expanded}
      selected={selected}
      onExpandedChange={onExpandedChange}
      onSelectFile={onSelectFile}
    />
  );
}

/** One row of the tree: either a real file/directory entry, or a non-interactive placeholder
 * standing in for a directory's loading/empty/error child state. */
type TreeRow =
  | { kind: "entry"; entry: AgentWorkspaceFileEntry; path: string }
  | { kind: "status"; id: string; loading: boolean; text: string };

function childRows(dirPath: string, cache: Record<string, DirState>): TreeRow[] {
  const state = cache[dirPath];
  if (!state || state.status === "loading") {
    return [{ kind: "status", id: `${dirPath}::loading`, loading: true, text: "" }];
  }
  if (state.status === "ready") {
    if (state.entries.length === 0) {
      return [
        {
          kind: "status",
          id: `${dirPath}::empty`,
          loading: false,
          text: m.agent_workspace_directory_empty(),
        },
      ];
    }
    return state.entries.map((entry) => ({
      kind: "entry",
      entry,
      path: joinPath(dirPath, entry.name),
    }));
  }
  return [
    {
      kind: "status",
      id: `${dirPath}::error`,
      loading: false,
      text: m.agent_workspace_directory_error(),
    },
  ];
}

/**
 * The lazily-loaded directory tree, built on React Aria's `Tree`. Collapsed directories
 * contribute no rows to the Collection, so expanding one is the only point a fetch happens.
 */
function WorkspaceTree({
  rootEntries,
  cache,
  expanded,
  selected,
  onExpandedChange,
  onSelectFile,
}: {
  rootEntries: AgentWorkspaceFileEntry[];
  cache: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | undefined;
  onExpandedChange: (next: Set<string>) => void;
  onSelectFile: (path: string) => void;
}) {
  // Read once per render: a refresh or an expansion re-renders the rows and moves their times on.
  const now = new Date();
  const locale = getLocale();

  function toggleExpandPath(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onExpandedChange(next);
  }

  function renderRow(row: TreeRow) {
    if (row.kind === "status") {
      return (
        <TreeItem id={row.id} textValue={row.text || m.agent_workspace_loading()} isDisabled>
          <TreeItemContent>
            {({ level }) => (
              <div
                className="flex min-w-0 items-center gap-1.5 py-1.5 pr-2 text-xs text-tertiary"
                style={{ paddingLeft: 4 + (level - 1) * 16 }}
              >
                <span aria-hidden="true" className="size-6 shrink-0" />
                {row.loading ? (
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                ) : (
                  row.text
                )}
              </div>
            )}
          </TreeItemContent>
        </TreeItem>
      );
    }

    const { entry, path } = row;
    const isDir = entry.type === "dir";
    const isCurrent = !isDir && selected === path;
    const time = workspaceEntryTime(entry, now, locale);

    return (
      <TreeItem
        id={path}
        textValue={entry.name}
        hasChildItems={isDir}
        onAction={() => (isDir ? toggleExpandPath(path) : onSelectFile(path))}
        className={cn(
          "cursor-pointer rounded-md outline-none data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-focus-ring data-hovered:bg-primary_hover",
          isCurrent && "bg-secondary",
        )}
      >
        <TreeItemContent>
          {({ level, isExpanded }) => (
            <div
              className="flex min-w-0 items-center gap-1.5 pr-2"
              style={{ paddingLeft: 4 + (level - 1) * 16 }}
            >
              {isDir ? (
                <AriaButton
                  slot="chevron"
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
                      isExpanded ? "rotate-90" : "rtl:rotate-180",
                    )}
                  />
                </AriaButton>
              ) : (
                <span aria-hidden="true" className="size-6 shrink-0" />
              )}
              {isDir ? (
                <Folder aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
              ) : (
                <FileTypeIcon fileName={entry.name} className="size-4" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 py-1.5 text-sm wrap-anywhere text-primary",
                  isCurrent && "font-medium",
                )}
              >
                {entry.name}
              </span>
              {time && (
                <time
                  dateTime={new Date(entry.modifiedAtMs).toISOString()}
                  className="shrink-0 text-xs text-tertiary tabular-nums"
                >
                  {time}
                </time>
              )}
            </div>
          )}
        </TreeItemContent>
        {/* Collapsed directories contribute no rows; files pass an always-empty list. */}
        <Collection
          items={isDir && expanded.has(path) ? childRows(path, cache) : []}
          dependencies={[expanded, cache, selected]}
        >
          {renderRow}
        </Collection>
      </TreeItem>
    );
  }

  return (
    <Tree
      aria-label={m.agent_workspace_section()}
      items={rootEntries.map((entry): TreeRow => ({ kind: "entry", entry, path: entry.name }))}
      dependencies={[expanded, cache, selected]}
      expandedKeys={expanded}
      onExpandedChange={(keys) => onExpandedChange(new Set([...keys].map(String)))}
      className="space-y-0.5 px-2 pb-3 outline-none"
    >
      {renderRow}
    </Tree>
  );
}
