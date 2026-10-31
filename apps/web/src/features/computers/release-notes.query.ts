import { queryOptions } from "@tanstack/react-query";

import { getComputerReleaseNotes } from "./computer-release.functions";

/**
 * A Computer release's notes from the release catalog, asked for only while that release is on
 * offer or being installed. They only decide whether "What's new" shows: a release without notes,
 * or a failed read, shows no link and never an error, and never holds up the Upgrade button.
 */
export const computerReleaseNotesQuery = (version: string | undefined) =>
  queryOptions({
    queryKey: ["computers", "release-notes", version ?? null],
    queryFn: () => getComputerReleaseNotes({ data: { version: version ?? "" } }),
    enabled: Boolean(version),
    staleTime: 5 * 60_000,
    retry: false,
  });
