import { Link } from "@tanstack/react-router";

import { ArtifactIcon, kindLabel } from "#src/features/artifacts/artifact-parts";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { SEARCH_HEADING_CLASS, SEARCH_ROW_CLASS } from "./search-entity-list";
import { SearchMatches } from "./search-matches";

export type FoundArtifact = {
  id: string;
  title: string;
  entryPath: string;
  currentVersion: number;
};

export function SearchArtifactList({
  artifacts,
  terms,
  onOpen,
}: {
  artifacts: FoundArtifact[];
  terms: string[];
  onOpen: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <section aria-labelledby="search-artifacts-heading" className="flex flex-col px-2 pt-2">
      <h2 id="search-artifacts-heading" className={SEARCH_HEADING_CLASS}>
        {m.navigation_artifacts()}
      </h2>
      <ul className="flex flex-col">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <Link
              to="/w/$workspaceSlug/artifacts/$artifactId"
              params={{ workspaceSlug, artifactId: artifact.id }}
              data-search-option=""
              data-search-artifact={artifact.id}
              onClick={onOpen}
              className={SEARCH_ROW_CLASS}
            >
              <ArtifactIcon entryPath={artifact.entryPath} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-primary">
                <SearchMatches text={artifact.title} terms={terms} lead={Infinity} />
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary tabular-nums">
                <span>{kindLabel(artifact.entryPath)}</span>
                <span>·</span>
                <span>v{artifact.currentVersion}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
