import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState } from "#src/components/ui/empty";
import { ComputersWireframe } from "#src/components/ui/empty-wireframes";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import {
  computerLabel,
  operatingSystemLabel,
  type ComputerIdentity,
  type ComputerPlatformInfo,
} from "./computer-identity";
import { BackToComputersContext } from "./back-to-computers";
import { ComputerTile } from "./computer-tile";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Button } from "#src/components/base/buttons/button";
import { humanLabel } from "#src/lib/human-label";
import { computerListUpdateVersion } from "./computer-identity";
import type { ComputerUpgradeStatus } from "./computer.schemas";
import { upgradeRunning } from "./computer-upgrade-status";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { activeRefusal, refusalLabel, type ComputerConnectRefusal } from "./computer-refusal";

export type ComputerListItem = ComputerIdentity &
  ComputerPlatformInfo & {
    id: string;
    online: boolean;
    connectRefusal?: ComputerConnectRefusal | null;
    ownedByCurrentUser: boolean;
    computerVersion?: string | null;
    releaseChannel?: string;
    imageVersion?: string | null;
    imageUpdate?: { version: string } | null;
    upgrade?: ComputerUpgradeStatus | null;
    creator?: {
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
    } | null;
  };

export function ComputerLayout({
  computers,
  selectedComputerId,
  onAdd,
  latestComputerVersions,
  children,
}: {
  computers: ComputerListItem[];
  selectedComputerId?: string;
  onAdd: () => void;
  latestComputerVersions?: ReadonlyMap<string, string | null>;
  children: ReactNode;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const [showMobileList, setShowMobileList] = useState(!selectedComputerId);
  const listHidden = Boolean(selectedComputerId) && !showMobileList;

  if (!computers.length) {
    return (
      <main className="flex h-full min-w-0">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
          <PageHeader heading={m.computer_page_title()} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoComputers onAdd={onAdd} />
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0">
      <nav
        aria-label={m.computer_connected_list()}
        className={cn(
          "min-w-0 flex-col overflow-hidden bg-primary md:flex md:w-80 md:shrink-0 md:border-r md:border-secondary",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.computer_page_title()} actions={<AddComputer onAdd={onAdd} />} />

        <ul className="flex-1 space-y-1 overflow-y-auto p-3">
          {computers.map((computer) => {
            const selected = computer.id === selectedComputerId;
            const creatorName = computer.creator ? humanLabel(computer.creator) : "";
            const refusal = activeRefusal(computer);
            const detail = refusal
              ? null
              : computer.name && computer.name !== computerLabel(computer)
                ? computer.name
                : operatingSystemLabel(computer);
            return (
              <li key={computer.id}>
                <div className="flex min-w-0 items-center">
                  <Link
                    to="/w/$workspaceSlug/computer/$computerId"
                    params={{ workspaceSlug, computerId: computer.id }}
                    aria-current={selected ? "page" : undefined}
                    resetScroll={false}
                    onClick={() => setShowMobileList(false)}
                    className={cn(
                      "group flex min-h-18 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                      selected
                        ? "bg-secondary text-brand-secondary hover:bg-secondary_hover"
                        : "hover:bg-primary_hover",
                    )}
                  >
                    <ComputerTile
                      computer={computer}
                      online={computer.online}
                      updateAvailableVersion={computerListUpdateVersion(
                        computer,
                        latestComputerVersions?.get(computer.releaseChannel ?? "latest"),
                      )}
                      upgrading={computer.ownedByCurrentUser && upgradeRunning(computer.upgrade)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm font-semibold">
                        {computerLabel(computer)}
                      </span>
                      {(refusal || detail || computer.computerVersion) && (
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          {refusal ? (
                            <span className="truncate text-xs text-error-primary">
                              {refusalLabel(refusal.reason)}
                            </span>
                          ) : (
                            detail && (
                              <span className="truncate text-xs text-tertiary">{detail}</span>
                            )
                          )}
                          {computer.computerVersion && (
                            <span
                              dir="ltr"
                              className={cn(
                                "min-w-0 truncate text-xs text-tertiary",
                                detail || refusal ? "max-w-28" : "max-w-full",
                              )}
                            >
                              {computer.computerVersion}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {computer.creator && (
                      <Tooltip
                        title={m.computer_added_by_name({
                          name: creatorName,
                        })}
                      >
                        <TooltipTrigger className="shrink-0 rounded-full">
                          <ActorAvatar
                            presence={false}
                            size="xs"
                            name={creatorName}
                            src={computer.creator.avatarUrl}
                          />
                          <span className="sr-only">{creatorName}</span>
                        </TooltipTrigger>
                      </Tooltip>
                    )}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
          listHidden ? "flex" : "hidden",
        )}
      >
        <BackToComputersContext value={() => setShowMobileList(true)}>
          {selectedComputerId || computers.some((computer) => computer.ownedByCurrentUser) ? (
            children
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NoComputers onAdd={onAdd} />
            </div>
          )}
        </BackToComputersContext>
      </section>
    </main>
  );
}

function AddComputer({ onAdd }: { onAdd: () => void }) {
  return (
    <Button size="sm" color="secondary" iconLeading={Plus} onPress={onAdd}>
      {m.computer_add_title()}
    </Button>
  );
}

function NoComputers({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      size="page"
      headingLevel={2}
      picture={<ComputersWireframe accent />}
      title={m.empty_computers_title()}
      description={m.empty_computers_description()}
      primaryAction={
        <Button iconLeading={Plus} onPress={onAdd}>
          {m.computer_add_title()}
        </Button>
      }
    />
  );
}
