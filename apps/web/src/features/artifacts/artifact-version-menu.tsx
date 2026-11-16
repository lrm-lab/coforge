import { useQuery } from "@tanstack/react-query";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { useArtifactTime } from "./artifact-parts";
import { artifactVersionsQuery } from "./artifact-queries";

export function VersionMenu({
  artifactId,
  shown,
  onChoose,
}: {
  artifactId: string;
  shown: number;
  onChoose: (version: number) => void;
}) {
  const { data } = useQuery(artifactVersionsQuery(artifactId));
  const time = useArtifactTime();
  return (
    <Dropdown.Menu
      aria-label={m.av_versions()}
      selectionMode="single"
      selectedKeys={[String(shown)]}
      onAction={(key) => onChoose(Number(key))}
      className="max-h-80"
    >
      {(data ?? []).map((version) => (
        <Dropdown.Item
          key={version.number}
          id={String(version.number)}
          textValue={`v${version.number}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="font-semibold">v{version.number}</span>
              {version.latest && (
                <span className="rounded-md bg-secondary px-1.5 text-xs font-medium text-tertiary">
                  {m.av_version_latest()}
                </span>
              )}
            </span>
            <span className="truncate text-xs font-normal text-tertiary">
              {m.av_version_by({
                name: version.publisher.name,
                time: time(version.createdAt),
              })}
            </span>
            {version.note && (
              <span className="truncate text-xs font-normal text-quaternary">{version.note}</span>
            )}
          </span>
        </Dropdown.Item>
      ))}
    </Dropdown.Menu>
  );
}
