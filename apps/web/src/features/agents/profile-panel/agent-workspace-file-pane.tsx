import { lazy, Suspense } from "react";
import { CatchBoundary } from "@tanstack/react-router";
import type { AgentWorkspaceFileReadResult } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { ProjectFileViewSkeleton } from "#src/features/projects/project-file-view-pending";
import { Attachment } from "#src/features/records/report-editor/attachment";
import { m } from "#src/paraglide/messages";
import { workspaceImageSource } from "./agent-workspace-image";

/** The file viewer (with the Markdown editor and syntax highlighter it renders with) loads only when
 * a file is opened: this tab is reachable from every chat page through the channel settings and
 * profile panels, and the viewer is the largest code on that path. */
export const loadProjectFileView = () =>
  import("#src/features/projects/project-file-view").then((module) => ({
    default: module.ProjectFileView,
  }));
const ProjectFileView = lazy(loadProjectFileView);

export type FileState =
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; result: AgentWorkspaceFileReadResult }
  | {
      status:
        | "offline"
        | "timeout"
        | "unavailable"
        | "missing"
        | "unreadable"
        | "binary"
        | "too_large"
        | "error";
      path: string;
    };

/** The Working directory tab's open file: the viewer for text, the image renderer for images, or
 * why it cannot be shown. */
export function FilePane({
  state,
  onRetry,
}: {
  state: FileState | undefined;
  onRetry: () => void;
}) {
  if (!state || state.status === "loading") {
    const name = state?.path.split("/").pop() ?? "";
    return <ProjectFileViewSkeleton name={name} />;
  }
  const name = state.path.split("/").pop() ?? state.path;

  if (state.status === "ready") {
    // An image read carries its bytes rather than text (the daemon sniffs the format), so it goes
    // to the existing image renderer: ProjectFileView is a text viewer and would show the data URL
    // as source. Everything else — text, and any read without an image payload — stays with it.
    const imageSource = workspaceImageSource(state.result);
    return (
      <CatchBoundary getResetKey={() => state.path} errorComponent={FilePreviewError}>
        {imageSource ? (
          <WorkspaceImagePreview name={name} url={imageSource} />
        ) : (
          <Suspense fallback={<ProjectFileViewSkeleton name={name} />}>
            <ProjectFileView
              key={state.path}
              path={state.path}
              name={name}
              byteSize={state.result.sizeBytes}
              text={state.result.text}
              githubUrl={undefined}
            />
          </Suspense>
        )}
      </CatchBoundary>
    );
  }
  if (state.status === "offline") return <EmptyFileState text={m.agent_workspace_offline()} />;
  if (state.status === "timeout")
    return <EmptyFileState text={m.agent_workspace_timeout()} onRetry={onRetry} />;
  if (state.status === "binary") return <EmptyFileState text={m.agent_workspace_binary()} />;
  if (state.status === "too_large") return <EmptyFileState text={m.agent_workspace_too_large()} />;
  return <EmptyFileState text={m.agent_workspace_file_error()} onRetry={onRetry} />;
}

function WorkspaceImagePreview({ name, url }: { name: string; url: string }) {
  return (
    // The image is sized by the pane, not by the file: `overflow-auto` keeps a tall screenshot
    // scrollable instead of letting it push the tree and header out of view.
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <Attachment attachment={{ kind: "url", url, filename: name, forceKind: "image" }} />
    </div>
  );
}

function FilePreviewError() {
  return (
    <EmptyFileState
      text={m.agent_workspace_preview_error()}
      alert
      onRetry={() => window.location.reload()}
      retryLabel={m.agent_workspace_reload()}
    />
  );
}

function EmptyFileState({
  text,
  onRetry,
  retryLabel = m.agent_workspace_retry(),
  alert = false,
}: {
  text: string;
  onRetry?: () => void;
  retryLabel?: string;
  alert?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <p role={alert ? "alert" : undefined} className="text-sm text-tertiary">
        {text}
      </p>
      {onRetry && (
        <Button size="sm" color="secondary" onPress={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
