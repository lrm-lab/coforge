import { useQuery } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { formatChangedPaths } from "./artifact-changed-paths";
import { artifactVersionsQuery } from "./artifact-queries";

export function ArtifactUpdateBanner({
  artifactId,
  incoming,
  onView,
}: {
  artifactId: string;
  incoming: number;
  onView: () => void;
}) {
  const { data } = useQuery(artifactVersionsQuery(artifactId));
  const version = data?.find((entry) => entry.number === incoming);
  const name = version?.publisher.name ?? "";
  const changed = version
    ? formatChangedPaths(version.changedPaths, version.changedCount)
    : undefined;
  return (
    <Alert
      color="brand"
      title={
        version?.note
          ? m.av_update_published_note({ name, version: incoming, note: version.note })
          : m.av_update_published({ name, version: incoming })
      }
      description={changed}
      className="mx-4 mt-3 shrink-0"
      actions={
        <Button size="sm" color="secondary" onClick={onView}>
          {m.av_update_view()}
        </Button>
      }
    />
  );
}

export function ViewingVersionNotice({
  version,
  failed,
  onBack,
}: {
  version: number;
  failed: boolean;
  onBack: () => void;
}) {
  return (
    <Alert
      color={failed ? "warning" : "gray"}
      title={failed ? m.av_version_failed({ version }) : m.av_viewing_version({ version })}
      className="mx-4 mt-3 shrink-0"
      actions={
        <Button size="sm" color="secondary" onClick={onBack}>
          {m.av_back_to_latest()}
        </Button>
      }
    />
  );
}
