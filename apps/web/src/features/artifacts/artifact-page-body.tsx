import { Suspense, lazy } from "react";

import type { ArtifactPathKind } from "./artifact-path-kind";
import { LoadingBody } from "./artifact-page-states";
import { ArtifactWebPage } from "./artifact-web-page";

const ArtifactFileView = lazy(() =>
  import("./artifact-file-view").then((module) => ({ default: module.ArtifactFileView })),
);

const ArtifactFile = lazy(() =>
  import("./artifact-file-view").then((module) => ({ default: module.ArtifactFile })),
);

const ArtifactMarkdown = lazy(() =>
  import("./artifact-markdown").then((module) => ({ default: module.ArtifactMarkdown })),
);

export function ArtifactPageBody({
  artifactId,
  shownVersion,
  title,
  entryPath,
  entryKind,
  text,
  openPath,
  source,
  webPage,
  finding,
  markdownFindOpen,
  onFindingChange,
  onCloseMarkdownFind,
  onCloseFile,
}: {
  artifactId: string;
  shownVersion: number;
  title: string;
  entryPath?: string | undefined;
  entryKind?: ArtifactPathKind | undefined;
  text?: string | undefined;
  openPath: string | null;
  source: boolean;
  webPage: boolean;
  finding: boolean;
  markdownFindOpen: boolean;
  onFindingChange: (finding: boolean) => void;
  onCloseMarkdownFind: () => void;
  onCloseFile: () => void;
}) {
  if (entryPath === undefined) return <LoadingBody />;
  if (openPath) {
    return (
      <Suspense fallback={<LoadingBody />}>
        <ArtifactFileView
          artifactId={artifactId}
          version={shownVersion}
          title={title}
          entryPath={entryPath}
          path={openPath}
          source={source}
          finding={finding}
          onFindingChange={onFindingChange}
          onBack={onCloseFile}
        />
      </Suspense>
    );
  }
  if (webPage) {
    return (
      <ArtifactWebPage
        key={shownVersion}
        artifactId={artifactId}
        version={shownVersion}
        title={title}
        entryPath={entryPath}
        path={entryPath}
        finding={finding}
        onFindingChange={onFindingChange}
      />
    );
  }
  if (entryKind === "markdown") {
    return (
      <Suspense fallback={<LoadingBody />}>
        <ArtifactMarkdown
          path={entryPath}
          text={text ?? ""}
          findOpen={markdownFindOpen}
          onFindClose={onCloseMarkdownFind}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<LoadingBody />}>
      <ArtifactFile artifactId={artifactId} version={shownVersion} path={entryPath} />
    </Suspense>
  );
}
