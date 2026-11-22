import { useQuery } from "@tanstack/react-query";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { formatChangedPaths } from "./artifact-changed-paths";
import { useArtifactTime } from "./artifact-parts";
import { artifactVersionsQuery } from "./artifact-queries";

const MENU_CHANGED_PATHS_SHOWN = 3;
const RETRY_KEY = "__retry__";
const EMPTY_KEY = "__empty__";

export function VersionMenu({
  artifactId,
  shown,
  onChoose,
}: {
  artifactId: string;
  shown: number;
  onChoose: (version: number) => void;
}) {
  const versions = useQuery(artifactVersionsQuery(artifactId));
  const time = useArtifactTime();
  const list = versions.data ?? [];
  return (
    <Dropdown.Menu
      aria-label={m.av_versions()}
      selectionMode="single"
      selectedKeys={[String(shown)]}
      onAction={(key) => {
        if (key === RETRY_KEY) {
          void versions.refetch();
          return;
        }
        if (key === EMPTY_KEY) return;
        onChoose(Number(key));
      }}
      className="max-h-80"
    >
      {versions.isError ? (
        <Dropdown.Item
          id={RETRY_KEY}
          textValue={m.empty_artifacts_versions_load_failed()}
          label={`${m.empty_artifacts_versions_load_failed()} · ${m.controls_retry()}`}
        />
      ) : versions.isPending ? (
        <Dropdown.Item id={EMPTY_KEY} isDisabled label={m.files_loading()} />
      ) : list.length === 0 ? (
        <Dropdown.Item id={EMPTY_KEY} isDisabled label={m.empty_picker_no_options()} />
      ) : (
        list.map((version) => {
          const changed = formatChangedPaths(
            version.changedPaths,
            version.changedCount,
            MENU_CHANGED_PATHS_SHOWN,
          );
          return (
            <Dropdown.Item
              key={version.number}
              id={String(version.number)}
              textValue={`v${version.number}`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-primary tabular-nums">v{version.number}</span>
                  {version.latest && (
                    <span className="text-xs text-tertiary">{m.av_version_latest()}</span>
                  )}
                </span>
                <span className="truncate text-xs text-tertiary">
                  {m.av_version_by({
                    name: version.publisher.name,
                    time: time(version.createdAt),
                  })}
                </span>
                {version.note && (
                  <span className="truncate text-xs text-tertiary">{version.note}</span>
                )}
                {changed && <span className="truncate text-xs text-quaternary">{changed}</span>}
              </span>
            </Dropdown.Item>
          );
        })
      )}
    </Dropdown.Menu>
  );
}
