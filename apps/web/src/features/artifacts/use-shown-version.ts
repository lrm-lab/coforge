import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { artifactDocumentQuery } from "./artifact-queries";

export function useShownVersion(
  artifactId: string,
  version: number | undefined,
  arrival: string | undefined,
) {
  const read = useQuery(artifactDocumentQuery(artifactId));
  const [pinnedState, setPinned] = useState<number | null>(version ?? null);
  useEffect(() => {
    setPinned(version ?? null);
  }, [version, arrival]);
  const latest = read.data?.artifact.currentVersion ?? 0;
  const pinned = pinnedState !== null && latest > 0 && pinnedState > latest ? null : pinnedState;
  const older = pinned !== null && pinned !== latest;
  const pinnedRead = useQuery({
    ...artifactDocumentQuery(artifactId, pinned ?? undefined),
    enabled: older,
  });
  const pin = useCallback((to: number) => setPinned(to === latest ? null : to), [latest]);
  return {
    read,
    latest,
    pinned,
    pinnedRead,
    current: older ? (pinnedRead.data ?? read.data) : read.data,
    shownVersion: older && pinnedRead.data ? pinned : latest,
    pin,
    unpin: () => setPinned(null),
  };
}
