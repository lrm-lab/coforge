import { useQuery } from "@tanstack/react-query";
import { Check } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { RelativeTime } from "#src/components/ui/relative-time";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { artifactVersionsQuery } from "./artifact-queries";

const RETRY_KEY = "__retry__";
const EMPTY_KEY = "__empty__";

export type VersionTimelineRowData = {
  number: number;
  latest: boolean;
  note: string;
  createdAt: Date | string;
  changedCount: number;
  publisher: {
    kind: "user" | "agent";
    id?: string | null;
    name: string;
    avatarUrl?: string | null;
  };
};

export function VersionPublisherAvatar({
  publisher,
}: {
  publisher: VersionTimelineRowData["publisher"];
}) {
  return (
    <ActorAvatar
      presence={false}
      userId={publisher.kind === "user" ? (publisher.id ?? undefined) : undefined}
      agentId={publisher.kind === "agent" ? (publisher.id ?? undefined) : undefined}
      src={publisher.avatarUrl ?? undefined}
      name={publisher.name}
      size="xs"
      className="size-4 shrink-0"
    />
  );
}

export function VersionTimelineRow({
  version,
  selected,
  isLast,
}: {
  version: VersionTimelineRowData;
  selected: boolean;
  isLast: boolean;
}) {
  const summary =
    version.note ||
    (version.number === 1
      ? m.av_version_initial()
      : m.av_version_updated({ version: version.number }));
  return (
    <div className="flex w-full items-stretch gap-2.5 py-1">
      <span aria-hidden="true" className="flex w-3 shrink-0 flex-col items-center pt-1.5">
        <span
          className={cn(
            "shrink-0 rounded-full",
            version.latest
              ? "size-2 bg-brand-solid ring-3 ring-brand/20"
              : "size-1.5 bg-fg-quaternary",
          )}
        />
        {!isLast && <span className="mt-1 -mb-3.5 w-px flex-1 bg-border-secondary" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-sm font-medium text-primary tabular-nums">v{version.number}</span>
            {version.latest && (
              <span className="inline-flex items-center rounded-full bg-success-primary px-1.5 py-0.5 text-xs leading-none font-medium text-success-primary">
                {m.av_version_latest()}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <RelativeTime
              value={version.createdAt}
              plain
              className="text-xs font-normal text-quaternary"
            />
            <Check
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-fg-brand-primary", !selected && "invisible")}
            />
          </span>
        </span>
        <span className="truncate text-xs font-normal text-secondary">{summary}</span>
        <span className="flex items-center gap-1.5 truncate text-xs font-normal text-tertiary">
          <VersionPublisherAvatar publisher={version.publisher} />
          <span className="truncate">{version.publisher.name}</span>
          {version.changedCount > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                {m.av_version_files_changed({ count: version.changedCount })}
              </span>
            </>
          )}
        </span>
      </span>
    </div>
  );
}

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
          selectionIndicator="none"
          textValue={m.empty_artifacts_versions_load_failed()}
          label={`${m.empty_artifacts_versions_load_failed()} · ${m.controls_retry()}`}
        />
      ) : versions.isPending ? (
        <Dropdown.Item
          id={EMPTY_KEY}
          selectionIndicator="none"
          isDisabled
          label={m.files_loading()}
        />
      ) : list.length === 0 ? (
        <Dropdown.Item
          id={EMPTY_KEY}
          selectionIndicator="none"
          isDisabled
          label={m.empty_picker_no_options()}
        />
      ) : (
        list.map((version, index) => {
          const selected = version.number === shown;
          return (
            <Dropdown.Item
              key={version.number}
              id={String(version.number)}
              selectionIndicator="none"
              textValue={`v${version.number}`}
              className={selected ? "[&>.cascade-menu-row]:bg-tertiary" : undefined}
            >
              <VersionTimelineRow
                version={version}
                selected={selected}
                isLast={index === list.length - 1}
              />
            </Dropdown.Item>
          );
        })
      )}
    </Dropdown.Menu>
  );
}
