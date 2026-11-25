import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft, Check, Copy01, Eye, EyeOff, RefreshCw01 } from "@untitledui/icons";
import { Toolbar } from "react-aria-components";
import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import {
  formatDisplayPath,
  splitDisplayPath,
  workspacePathMaxLength,
} from "#src/features/agents/display-path";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { cn } from "#src/lib/utils";
import { FilePane, loadProjectFileView, type FileState } from "./agent-workspace-file-pane";
import { sameEntries, sameFileRead } from "./agent-workspace-same";
import { TreeRoot, type DirState } from "./agent-workspace-tree";

const SPLIT_BREAKPOINT_PX = 900;
const SPLIT_TREE_WIDTH_PX = 288;
const COMPACT_TREE_BREAKPOINT_PX = 420;
const COPY_CONFIRM_MS = 1800;
const SAME_RETURN_MS = 1000;

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
  } catch {}
}

function sortedEntries(entries: AgentWorkspaceFileEntry[]): AgentWorkspaceFileEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

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
  const [copied, setCopied] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  const cacheRef = useRef<Record<string, DirState>>({});
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const dirSeq = useRef<Record<string, number>>({});
  const fileSeq = useRef(0);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  useEffect(() => {
    clearTimeout(copyTimerRef.current);
    setCopied(false);
    return () => {
      clearTimeout(copyTimerRef.current);
    };
  }, [agentId]);

  const setDirState = useCallback((dirPath: string, state: DirState) => {
    cacheRef.current = { ...cacheRef.current, [dirPath]: state };
    forceRender();
  }, []);

  const loadDir = useCallback(
    async (dirPath: string, hidden: boolean, quiet = false) => {
      const seq = (dirSeq.current[dirPath] ?? 0) + 1;
      dirSeq.current[dirPath] = seq;
      if (!(quiet && cacheRef.current[dirPath]?.status === "ready"))
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
        if (dirPath === "") setRootPath(response.result.rootPath || undefined);
        const entries = sortedEntries(response.result.entries);
        const shown = cacheRef.current[dirPath];
        if (shown?.status === "ready" && sameEntries(shown.entries, entries)) return;
        setDirState(dirPath, { status: "ready", entries });
      } catch {
        if (dirSeq.current[dirPath] === seq) setDirState(dirPath, { status: "error" });
      }
    },
    [onListDir, setDirState],
  );

  const loadFile = useCallback(
    async (path: string, quiet = false) => {
      const seq = ++fileSeq.current;
      const shown = fileStateRef.current;
      if (!(quiet && shown?.status === "ready" && shown.path === path))
        setFileState({ status: "loading", path });
      void loadProjectFileView().catch(() => undefined);
      try {
        const response = await onReadFile(path);
        if (fileSeq.current !== seq) return;
        if (response.status !== "ready") {
          setFileState({ status: response.status, path });
          return;
        }
        if (response.result.status !== "ok") {
          setFileState({ status: response.result.status, path });
          return;
        }
        const current = fileStateRef.current;
        if (
          current?.status === "ready" &&
          current.path === path &&
          sameFileRead(current.result, response.result)
        )
          return;
        setFileState({ status: "ready", path, result: response.result });
      } catch {
        if (fileSeq.current === seq) setFileState({ status: "error", path });
      }
    },
    [onReadFile],
  );

  useEffect(() => {
    void loadDir("", includeHidden);
    for (const dir of expanded) void loadDir(dir, includeHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch driven by includeHidden/agentId only.
  }, [agentId, includeHidden]);

  function toggleHidden() {
    const next = !includeHidden;
    setIncludeHidden(next);
    writeHiddenPreference(agentId, next);
  }

  function refresh() {
    void loadDir("", includeHidden, true);
    for (const dir of expanded) void loadDir(dir, includeHidden, true);
    if (selected) void loadFile(selected, true);
  }

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      const now = performance.now();
      if (now - SAME_RETURN_MS < last) return;
      last = now;
      refreshRef.current();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

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
    if (!rootPath) return;
    if (!(await copyText(rootPath))) return;
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  }

  const rootState = cacheRef.current[""];
  const isRootLoading = !rootState || rootState.status === "loading";
  const showSplit = containerWidth >= SPLIT_BREAKPOINT_PX;
  const paneWidth = showSplit ? SPLIT_TREE_WIDTH_PX : containerWidth;
  const compactTree = paneWidth > 0 && paneWidth < COMPACT_TREE_BREAKPOINT_PX;
  const narrowShowingFile = !showSplit && selected !== undefined;

  const tree = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TreeRoot
        state={rootState}
        cache={cacheRef.current}
        expanded={expanded}
        selected={selected}
        compact={compactTree}
        onExpandedChange={applyExpanded}
        onSelectFile={selectFile}
        onRetry={() => loadDir("", includeHidden)}
      />
    </div>
  );

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
                className="shrink-0 [&_svg]:rtl:rotate-180"
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
            <WorkspaceBar
              rootPath={rootPath}
              isLoading={isRootLoading}
              paneWidth={paneWidth}
              copied={copied}
              includeHidden={includeHidden}
              onCopyPath={() => void copyPath()}
              onToggleHidden={toggleHidden}
              onRefresh={refresh}
            />
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

function WorkspaceBar({
  rootPath,
  isLoading,
  paneWidth,
  copied,
  includeHidden,
  onCopyPath,
  onToggleHidden,
  onRefresh,
}: {
  rootPath: string | undefined;
  isLoading: boolean;
  paneWidth: number;
  copied: boolean;
  includeHidden: boolean;
  onCopyPath: () => void;
  onToggleHidden: () => void;
  onRefresh: () => void;
}) {
  const shownPath = rootPath
    ? formatDisplayPath(rootPath, workspacePathMaxLength(paneWidth))
    : undefined;
  const { prefix, leaf } = splitDisplayPath(shownPath ?? "");
  const copyTooltip = copied ? m.agent_workspace_path_copied() : m.agent_workspace_copy_path();

  return (
    <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-secondary bg-secondary py-1.5 ps-4 pe-2.5">
      <div className="min-w-0 flex-1">
        {isLoading && !rootPath ? (
          <span
            aria-hidden="true"
            className="block h-3.5 w-40 max-w-full animate-pulse rounded bg-tertiary motion-reduce:animate-none"
          />
        ) : rootPath ? (
          <Tooltip title={copied ? m.agent_workspace_path_copied() : rootPath}>
            <TooltipTrigger
              onPress={onCopyPath}
              aria-label={`${copyTooltip}: ${rootPath}`}
              className="relative -mx-1.5 -my-0.5 block max-w-full min-w-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-start font-mono text-xs leading-5 text-quaternary outline-focus-ring transition-colors duration-100 ease-out hover:bg-tertiary focus-visible:outline-2 focus-visible:outline-solid any-pointer-coarse:after:absolute any-pointer-coarse:after:inset-x-0 any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:-translate-y-1/2"
            >
              <span dir="ltr" className="block truncate">
                {prefix}
                <span className="font-medium text-primary">{leaf}</span>
              </span>
            </TooltipTrigger>
          </Tooltip>
        ) : (
          <span className="block truncate text-xs text-quaternary">
            {m.agent_workspace_path_unavailable()}
          </span>
        )}
      </div>

      <Toolbar
        aria-label={m.agent_workspace_section()}
        className="flex shrink-0 items-center gap-0.5"
      >
        <ButtonUtility
          icon={copied ? Check : Copy01}
          size="xs"
          color="tertiary"
          isDisabled={!rootPath}
          tooltip={copyTooltip}
          onClick={onCopyPath}
          className={cn(
            "hover:bg-tertiary",
            copied &&
              "bg-success-primary text-success-primary hover:bg-success-primary hover:text-success-primary",
          )}
        />
        <ButtonUtility
          icon={includeHidden ? EyeOff : Eye}
          size="xs"
          color="tertiary"
          tooltip={
            includeHidden
              ? m.agent_workspace_hidden_files_shown()
              : m.agent_workspace_hidden_files_hidden()
          }
          onClick={onToggleHidden}
          className={cn(
            "hover:bg-tertiary",
            includeHidden && "bg-tertiary text-primary hover:bg-tertiary hover:text-primary",
          )}
        />
        <ButtonUtility
          icon={RefreshCw01}
          size="xs"
          color="tertiary"
          tooltip={m.agent_workspace_refresh()}
          onClick={onRefresh}
          className="hover:bg-tertiary"
        />
      </Toolbar>

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copied ? m.agent_workspace_path_copied() : ""}
      </span>
    </div>
  );
}
