import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Grid01 } from "@untitledui/icons";
import { Button as AriaButton, Focusable } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { useArtifactTime } from "./artifact-parts";
import { artifactListQuery } from "./artifact-queries";
import { orderRecentArtifacts, recordRecentArtifactOpen } from "./artifact-recent-order";

const ALL_KEY = "__see_all__";

export function RecentArtifactsMenu({
  conversationId,
  artifactId,
  titleId,
  title,
  onSwitch,
}: {
  conversationId: string;
  artifactId: string;
  titleId: string;
  title: string;
  onSwitch: (artifactId: string) => void;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const formatTime = useArtifactTime();
  const [recentIds, setRecentIds] = useState<string[]>(() => [artifactId]);
  const list = useQuery(artifactListQuery(conversationId));

  useEffect(() => {
    setRecentIds(recordRecentArtifactOpen(conversationId, artifactId));
  }, [conversationId, artifactId]);

  const items = useMemo(
    () => orderRecentArtifacts(list.data ?? [], recentIds, 8),
    [list.data, recentIds],
  );

  if (items.length <= 1) {
    return (
      <Tooltip title={title} placement="bottom start">
        <Focusable>
          <h2
            id={titleId}
            tabIndex={0}
            className="min-w-0 truncate rounded-sm text-sm font-medium text-primary outline-focus-ring focus-visible:outline-2"
          >
            {title}
          </h2>
        </Focusable>
      </Tooltip>
    );
  }

  return (
    <Dropdown.Root>
      <Tooltip title={title} placement="bottom start">
        <AriaButton
          aria-label={m.ag_sort_opened()}
          className="flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-lg px-1.5 text-left text-sm font-medium text-primary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2"
        >
          <h2 id={titleId} className="min-w-0 truncate">
            {title}
          </h2>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        </AriaButton>
      </Tooltip>
      <Dropdown.Popover placement="bottom start" className="w-72">
        <Dropdown.Menu
          aria-label={m.ag_sort_opened()}
          onAction={(key) => {
            const value = String(key);
            if (value === ALL_KEY) {
              void router.navigate({
                to: "/w/$workspaceSlug/artifacts",
                params: { workspaceSlug },
              });
              return;
            }
            if (value !== artifactId) onSwitch(value);
          }}
        >
          {items.map((item) => {
            const current = item.id === artifactId;
            return (
              <Dropdown.Item key={item.id} id={item.id} textValue={item.title || m.doc_untitled()}>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-primary">
                      {item.title || m.doc_untitled()}
                    </div>
                    <div className="truncate text-xs text-tertiary tabular-nums">
                      {m.av_version_by({
                        name: `v${item.currentVersion}`,
                        time: formatTime(item.updatedAt),
                      })}
                    </div>
                  </div>
                  {current && (
                    <Check aria-hidden="true" className="size-4 shrink-0 text-fg-brand-primary" />
                  )}
                </div>
              </Dropdown.Item>
            );
          })}
          <Dropdown.Separator />
          <Dropdown.Item id={ALL_KEY} icon={Grid01} label={m.ag_see_all()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
