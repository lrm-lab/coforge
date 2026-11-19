import { useCallback, useEffect, useState } from "react";

import {
  isSearchMemoryKey,
  readSearchHistory,
  readSearchUsage,
  withOpen,
  withSearch,
  writeSearchHistory,
  writeSearchUsage,
  type SearchEntityKey,
} from "./search-memory";

function readMemory(workspaceId: string, userId: string) {
  return {
    history: readSearchHistory(workspaceId, userId),
    usage: readSearchUsage(workspaceId, userId),
  };
}

export function useSearchMemory(workspaceId: string, userId: string) {
  const scope = `${workspaceId}:${userId}`;
  const [memory, setMemory] = useState(() => ({
    scope,
    ...readMemory(workspaceId, userId),
  }));

  const reload = useCallback(
    () => setMemory({ scope, ...readMemory(workspaceId, userId) }),
    [scope, workspaceId, userId],
  );

  useEffect(() => {
    if (memory.scope !== scope) reload();
    const onStorage = (event: StorageEvent) => {
      if (isSearchMemoryKey(event.key, workspaceId, userId)) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [memory.scope, scope, reload, workspaceId, userId]);

  const updateHistory = useCallback(
    (change: (history: string[]) => string[]) => {
      writeSearchHistory(workspaceId, userId, change(readSearchHistory(workspaceId, userId)));
      reload();
    },
    [workspaceId, userId, reload],
  );

  const recordOpen = useCallback(
    (query: string, entity: SearchEntityKey | undefined) => {
      if (query.trim()) updateHistory((history) => withSearch(history, query));
      if (entity) {
        const usage = withOpen(readSearchUsage(workspaceId, userId), entity, Date.now());
        writeSearchUsage(workspaceId, userId, usage);
        reload();
      }
    },
    [workspaceId, userId, updateHistory, reload],
  );

  const removeSearch = useCallback(
    (query: string) => updateHistory((history) => history.filter((entry) => entry !== query)),
    [updateHistory],
  );

  const clearHistory = useCallback(() => updateHistory(() => []), [updateHistory]);

  return {
    history: memory.history,
    usage: memory.usage,
    recordOpen,
    removeSearch,
    clearHistory,
  };
}
