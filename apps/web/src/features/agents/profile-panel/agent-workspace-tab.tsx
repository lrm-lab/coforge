import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Copy01, DotsHorizontal, Eye, EyeOff, RefreshCw01 } from "@untitledui/icons";
import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { cn } from "#src/lib/utils";
import { FilePane, loadProjectFileView, type FileState } from "./agent-workspace-file-pane";
import { TreeRoot, type DirState } from "./agent-workspace-tree";

/** The container width, in CSS px, at and above which the tree and the open file split
 * side-by-side (the wide Members-page pane). Below it, the file replaces the tree and a
 * breadcrumb + back button return to it (the panel's own narrow width) — a single breakpoint,
 * simpler than a true three-way responsive layout and acceptable per the brief. */
const SPLIT_BREAKPOINT_PX = 900;

export type AgentWorkspaceFilesLoadResult =
  | { status: "ready"; result: AgentWorkspaceFilesListResult }
  | { status: "offline" | "timeout" | "unavailable" };
export type AgentWorkspaceFileLoadResult =
  | { status: "ready"; result: AgentWorkspaceFileReadResult }
  | { status: "offline" | "timeout" | "unavailable" };

function hiddenStorageKey(agentId: string) {
  return `coforge:agent-workspace-hidden:${agentId}`;
}

function readHiddenPreference(agentId: string): boolean {
  try {
    return localStorage.getItem(hiddenStorageKey(agentId)) === "1";
  } catch {
    return false;
  }
}

function writeHiddenPreference(agentId: string, value: boolean) {
  try {
    localStorage.setItem(hiddenStorageKey(agentId), value ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the choice still holds for this visit.
  }
}

function sortedEntries(entries: AgentWorkspaceFileEntry[]): AgentWorkspaceFileEntry[] {
  // The daemon already returns directories-first, name-sorted, but this component sorts
  // defensively rather than trusting that contract.
  return [...entries].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The Agent profile panel's Workspace tab: a lazy directory tree of the Agent's working directory
 * on its Computer, plus a read-only file viewer. Creator/admin only (caller gates via
 * `visibleAgentProfileTabs`), with the same publish/poll/timeout data shape
 * as Skills, but with two operations (list, read) instead of one.
 */
export function AgentWorkspaceTab({
  agentId,
  onListDir,
  onReadFile,
}: {
  agentId: string;
  onListDir: (dirPath: string, includeHidden: boolean) => Promise<AgentWorkspaceFilesLoadResult>;
  onReadFile: (path: string) => Promise<AgentWorkspaceFileLoadResult>;
}) {
  const [includeHidden, setIncludeHidden] = useState(() => readHiddenPreference(agentId));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fileState, setFileState] = useState<FileState | undefined>(undefined);
  const [rootPath, setRootPath] = useState<string | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(0);

  const cacheRef = useRef<Record<string, DirState>>({});
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const dirSeq = useRef<Record<string, number>>({});
  const fileSeq = useRef(0);
  const fileStateRef = useRef(fileState);
  fileStateRef.current = fileState;

  const containerRef = useRef<HTMLDivElement | null>(null);
  useResizeObserver({
    ref: containerRef,
    onResize: () => setContainerWidth(containerRef.current?.clientWidth ?? 0),
  });
  useEffect(() => {
    setContainerWidth(containerRef.current?.clientWidth ?? 0);
  }, []);

  const setDirState = useCallback((dirPath: string, state: DirState) => {
    cacheRef.current = { ...cacheRef.current, [dirPath]: state };
    forceRender();
  }, []);

  const loadDir = useCallback(
    async (dirPath: string, hidden: boolean, quiet = false) => {
      const seq = (dirSeq.current[dirPath] ?? 0) + 1;
      dirSeq.current[dirPath] = seq;
      // A quiet reload (the reader coming back to the window) keeps what is listed on screen
      // while it reads, and keeps it too if the read fails: only a list that changed redraws.
      const keep = quiet && cacheRef.current[dirPath]?.status === "ready";
      if (!keep) setDirState(dirPath, { status: "loading" });
      try {
        const response = await onListDir(dirPath, hidden);
        if (dirSeq.current[dirPath] !== seq) return;
        if (response.status !== "ready") {
          if (!keep) setDirState(dirPath, { status: response.status });
          return;
        }
        if (response.result.status !== "ok") {
          if (!keep) setDirState(dirPath, { status: response.result.status });
          return;
        }
        if (dirPath === "") setRootPath(response.result.rootPath);
        setDirState(dirPath, { status: "ready", entries: sortedEntries(response.result.entries) });
      } catch {
        if (dirSeq.current[dirPath] === seq && !keep) setDirState(dirPath, { status: "error" });
      }
    },
    [onListDir, setDirState],
  );

  const loadFile = useCallback(
    async (path: string, quiet = false) => {
      const seq = ++fileSeq.current;
      const keep = quiet && fileStateRef.current?.status === "ready";
      if (!keep) setFileState({ status: "loading", path });
      // Fetch the viewer's code alongside the file rather than after it arrives. A failed load
      // is reported when the viewer renders, so this early request drops its own error.
      void loadProjectFileView().catch(() => undefined);
      try {
        const response = await onReadFile(path);
        if (fileSeq.current !== seq) return;
        if (response.status !== "ready") {
          if (!keep) setFileState({ status: response.status, path });
          return;
        }
        if (response.result.status === "ok") {
          setFileState({ status: "ready", path, result: response.result });
        } else if (!keep) {
          setFileState({ status: response.result.status, path });
        }
      } catch {
        if (fileSeq.current === seq && !keep) setFileState({ status: "error", path });
      }
    },
    [onReadFile],
  );

  useEffect(() => {
    void loadDir("", includeHidden);
    // Reload every directory expanded so far so a hidden-files toggle applies everywhere at once.
    for (const dir of expanded) void loadDir(dir, includeHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch driven by includeHidden/agentId only.
  }, [agentId, includeHidden]);

  function toggleHidden() {
    const next = !includeHidden;
    setIncludeHidden(next);
    writeHiddenPreference(agentId, next);
  }

  // Reads everything on screen again without blanking it: the list, every open folder and the
  // open file.
  function refresh() {
    void loadDir("", includeHidden, true);
    for (const dir of expanded) void loadDir(dir, includeHidden, true);
    if (selected) void loadFile(selected, true);
  }

  // The Agent keeps writing while the reader is elsewhere, so coming back to the window reads
  // again (there is no push for file changes). The menu keeps a Refresh for staying put.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") refreshRef.current();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  // Single entry point for every expansion change, whether it comes from the tree's own
  // chevron toggle (a full next set) or a row click on a directory (one path flipped below).
  // Any directory newly present in `next` that isn't cached yet gets fetched.
  function applyExpanded(next: Set<string>) {
    for (const dirPath of next) {
      if (!expanded.has(dirPath) && !cacheRef.current[dirPath])
        void loadDir(dirPath, includeHidden);
    }
    setExpanded(next);
  }

  function selectFile(path: string) {
    setSelected(path);
    void loadFile(path);
  }

  async function copyPath() {
    if (rootPath) await copyText(rootPath);
  }

  const rootState = cacheRef.current[""];
  const showSplit = containerWidth >= SPLIT_BREAKPOINT_PX;
  const narrowShowingFile = !showSplit && selected !== undefined;

  const menu = (
    <WorkspaceMenu
      includeHidden={includeHidden}
      canCopyPath={rootPath !== undefined}
      onRefresh={refresh}
      onToggleHidden={toggleHidden}
      onCopyPath={() => void copyPath()}
    />
  );
  const tree = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TreeRoot
        state={rootState}
        cache={cacheRef.current}
        expanded={expanded}
        selected={selected}
        onExpandedChange={applyExpanded}
        onSelectFile={selectFile}
        onRetry={() => loadDir("", includeHidden)}
      />
    </div>
  );

  // One bar above the content, never a stack of them: the list's bar holds only its menu, and an
  // open file's bar (the viewer's own) carries the way back on a narrow panel.
  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {narrowShowingFile ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <FilePane
            state={fileState}
            onRetry={() => selected && loadFile(selected)}
            leading={
              <ButtonUtility
                icon={ArrowLeft}
                size="xs"
                color="tertiary"
                className="shrink-0"
                tooltip={m.agent_workspace_back()}
                onClick={() => setSelected(undefined)}
              />
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "flex min-h-0 flex-col",
              showSplit ? "w-72 shrink-0 border-r border-secondary" : "min-h-0 flex-1",
            )}
          >
            <ListBar>{menu}</ListBar>
            {tree}
          </div>
          {showSplit && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {selected ? (
                <FilePane state={fileState} onRetry={() => selected && loadFile(selected)} />
              ) : (
                <p className="px-5 py-16 text-center text-sm text-tertiary">
                  {m.agent_workspace_select_file()}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The list's bar: as tall as an open file's bar, so going in and out of a file does not shift
 * the content. */
function ListBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-12 shrink-0 items-center justify-end border-b border-secondary px-3 py-2">
      {children}
    </div>
  );
}

/** What the list does besides opening files, all used now and then, so they wait behind one
 * button instead of each holding a place on screen. */
function WorkspaceMenu({
  includeHidden,
  canCopyPath,
  onRefresh,
  onToggleHidden,
  onCopyPath,
}: {
  includeHidden: boolean;
  canCopyPath: boolean;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onCopyPath: () => void;
}) {
  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={DotsHorizontal}
        size="xs"
        color="tertiary"
        tooltip={m.agent_workspace_more()}
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={m.agent_workspace_more()}
          disabledKeys={canCopyPath ? [] : ["copy"]}
          onAction={(key) =>
            key === "refresh" ? onRefresh() : key === "hidden" ? onToggleHidden() : onCopyPath()
          }
        >
          <Dropdown.Item id="refresh" icon={RefreshCw01} label={m.agent_workspace_refresh()} />
          <Dropdown.Item
            id="hidden"
            icon={includeHidden ? EyeOff : Eye}
            label={
              includeHidden
                ? m.agent_workspace_hidden_files_shown()
                : m.agent_workspace_hidden_files_hidden()
            }
          />
          <Dropdown.Item id="copy" icon={Copy01} label={m.agent_workspace_copy_path()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
