import { Download01, Home02, XClose } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { artifactDownloadUrl } from "./artifact-download-url";

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
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const current = openPath ?? entryPath;
  return (
    <aside
      aria-label={m.av_menu_files()}
      className="flex w-[340px] shrink-0 flex-col border-l border-secondary bg-primary max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-auto"
    >
      <div className="flex items-start gap-2 border-b border-secondary px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-primary">{m.av_menu_files()}</h2>
          <p className="text-xs text-tertiary">
            {m.av_files_summary({ count: files.length, size: formatBytes(total) })}
          </p>
        </div>
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={m.av_files_close()}
          onClick={onClose}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.map((file) => (
          <li key={file.path}>
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary_hover",
                file.path === current && "bg-active",
              )}
            >
              {file.path === entryPath && (
                <Home02
                  aria-label={m.av_file_entry()}
                  className="size-4 shrink-0 text-fg-quaternary"
                />
              )}
              <AriaButton
                className="min-w-0 flex-1 truncate text-left text-sm text-secondary outline-focus-ring focus-visible:outline-2"
                onPress={() => onOpen(file.path === entryPath ? null : file.path)}
              >
                {file.path}
              </AriaButton>
              <span className="shrink-0 text-xs text-tertiary tabular-nums">
                {formatBytes(file.sizeBytes)}
              </span>
              <ButtonUtility
                icon={Download01}
                size="xs"
                color="tertiary"
                tooltip={m.av_file_download({ name: file.path })}
                href={artifactDownloadUrl(workspaceSlug, artifactId, { path: file.path, version })}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
