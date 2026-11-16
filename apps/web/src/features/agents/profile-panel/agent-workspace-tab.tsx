import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft, Copy01, Eye, EyeOff, RefreshCw01 } from "@untitledui/icons";
import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { cn } from "#src/lib/utils";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";
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
    async (dirPath: string, hidden: boolean) => {
      const seq = (dirSeq.current[dirPath] ?? 0) + 1;
      dirSeq.current[dirPath] = seq;
      setDirState(dirPath, { status: "loading" });
      try {
        const response = await onListDir(dirPath, hidden);
        if (dirSeq.current[dirPath] !== seq) return;
        if (response.status !== "ready") {
          setDirState(dirPath, { status: response.status });
          return;
        }
        if (response.result.status !== "ok") {
          setDirState(dirPath, { status: response.result.status });
          return;
        }
        if (dirPath === "") setRootPath(response.result.rootPath);
        setDirState(dirPath, { status: "ready", entries: sortedEntries(response.result.entries) });
      } catch {
        if (dirSeq.current[dirPath] === seq) setDirState(dirPath, { status: "error" });
      }
    },
    [onListDir, setDirState],
  );

  const loadFile = useCallback(
    async (path: string) => {
      const seq = ++fileSeq.current;
      setFileState({ status: "loading", path });
      // Fetch the viewer's code alongside the file rather than after it arrives. A failed load
      // is reported when the viewer renders, so this early request drops its own error.
      void loadProjectFileView().catch(() => undefined);
      try {
        const response = await onReadFile(path);
        if (fileSeq.current !== seq) return;
        if (response.status !== "ready") {
          setFileState({ status: response.status, path });
          return;
        }
        if (response.result.status === "ok") {
          setFileState({ status: "ready", path, result: response.result });
        } else {
          setFileState({ status: response.result.status, path });
        }
      } catch {
        if (fileSeq.current === seq) setFileState({ status: "error", path });
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

  function refresh() {
    void loadDir("", includeHidden);
    for (const dir of expanded) void loadDir(dir, includeHidden);
    if (selected) void loadFile(selected);
  }

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

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* One line: the path truncates, so the copy button must not wrap below it. `flex-wrap`
       * would send the button to a second line as soon as the path's full width exceeds the row. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary px-5 py-3">
        <span className="min-w-0 truncate font-mono text-xs text-tertiary">{rootPath ?? " "}</span>
        {rootPath && (
          <ButtonUtility
            icon={Copy01}
            size="xs"
            color="tertiary"
            className="shrink-0"
            tooltip={m.agent_workspace_copy_path()}
            onClick={() => void copyPath()}
          />
        )}
      </div>

      {!showSplit && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary px-5 py-2.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_workspace_section()}</p>
          <HiddenAndRefreshButtons
            includeHidden={includeHidden}
            onToggleHidden={toggleHidden}
            onRefresh={refresh}
          />
        </div>
      )}

      {narrowShowingFile ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-secondary px-3 py-2">
            <ButtonUtility
              icon={ArrowLeft}
              size="xs"
              color="tertiary"
              tooltip={m.agent_workspace_back()}
              onClick={() => setSelected(undefined)}
            />
            <span className="min-w-0 truncate font-mono text-xs text-tertiary">{selected}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <FilePane state={fileState} onRetry={() => selected && loadFile(selected)} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "flex min-h-0 flex-col",
              showSplit ? "w-72 shrink-0 border-r border-secondary" : "min-h-0 flex-1",
            )}
          >
            {showSplit && (
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
                <p className={SECTION_CAPTION_CLASS}>{m.agent_workspace_section()}</p>
                <HiddenAndRefreshButtons
                  includeHidden={includeHidden}
                  onToggleHidden={toggleHidden}
                  onRefresh={refresh}
                />
              </div>
            )}
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

function HiddenAndRefreshButtons({
  includeHidden,
  onToggleHidden,
  onRefresh,
}: {
  includeHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ButtonUtility
        icon={includeHidden ? Eye : EyeOff}
        size="xs"
        color="tertiary"
        tooltip={
          includeHidden
            ? m.agent_workspace_hidden_files_shown()
            : m.agent_workspace_hidden_files_hidden()
        }
        onClick={onToggleHidden}
      />
      <ButtonUtility
        icon={RefreshCw01}
        size="xs"
        color="tertiary"
        tooltip={m.agent_workspace_refresh()}
        onClick={onRefresh}
      />
    </div>
  );
}
