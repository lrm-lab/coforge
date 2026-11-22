import { Download01, File02, Home02 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { ReviewPanelHeader } from "#src/features/conversations/review-panel-header";
import { m } from "#src/paraglide/messages";
import { artifactDownloadUrl } from "./artifact-download-url";
import { middleTruncatePath } from "./artifact-file-path";
import { ArtifactSidePanel } from "./artifact-side-panel";

type PanelFile = { path: string; sizeBytes: number };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArtifactFilesPanel({
  artifactId,
  version,
  entryPath,
  files,
  openPath,
  onOpen,
  onClose,
}: {
  artifactId: string;
  version: number;
  entryPath: string;
  files: readonly PanelFile[];
  openPath: string | null;
  onOpen: (path: string | null) => void;
  onClose: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const current = openPath ?? entryPath;
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return (
    <ArtifactSidePanel label={m.av_menu_files()} onClose={onClose}>
      <ReviewPanelHeader
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">{m.av_menu_files()}</span>
            <span className="min-w-0 truncate text-xs font-normal text-tertiary tabular-nums">
              {m.av_files_summary({ count: files.length, size: formatBytes(totalBytes) })}
            </span>
          </span>
        }
        close={{ label: m.av_files_close(), onPress: onClose }}
      />
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.map((file) => {
          const displayPath = middleTruncatePath(file.path, 28);
          return (
            <li key={file.path}>
              <div
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md pr-0.5 pl-2 transition-colors duration-150 hover:bg-primary_hover",
                  file.path === current && "bg-active",
                )}
              >
                {file.path === entryPath ? (
                  <Home02
                    aria-label={m.av_file_entry()}
                    className="size-4 shrink-0 text-fg-quaternary"
                  />
                ) : (
                  <File02 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                )}
                <Tooltip title={file.path} isDisabled={displayPath === file.path}>
                  <AriaButton
                    aria-label={file.path}
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs text-secondary outline-focus-ring focus-visible:outline-2"
                    onPress={() => onOpen(file.path === entryPath ? null : file.path)}
                  >
                    {displayPath}
                  </AriaButton>
                </Tooltip>
                <span className="shrink-0 text-xs text-tertiary tabular-nums">
                  {formatBytes(file.sizeBytes)}
                </span>
                <ButtonUtility
                  icon={Download01}
                  size="xs"
                  color="tertiary"
                  tooltip={m.av_file_download({ name: file.path })}
                  href={artifactDownloadUrl(workspaceSlug, artifactId, {
                    path: file.path,
                    version,
                  })}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </ArtifactSidePanel>
  );
}
