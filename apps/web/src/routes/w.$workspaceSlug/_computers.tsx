import { useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  createFileRoute,
  getRouteApi,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueries, useQuery } from "@tanstack/react-query";
import { latestComputerVersionQuery } from "#src/features/computers/latest-version.query";
import { AddComputerDialog } from "#src/features/computers/add-computer-dialog";
import { CloudDesktopOriginProvider } from "#src/features/computers/cloud-desktop-origin";
import { ComputerLayout } from "#src/features/computers/computer-layout";
import { ComputersPending } from "#src/features/computers/computers-pending";
import { ensureCloudComputer } from "#src/features/computers/cloud-computers.functions";
import { listComputerConnections } from "#src/features/computers/computer-connection.functions";
import { getCloudDesktopOrigin } from "#src/features/computers/cloud-desktop-origin.functions";
import {
  readComputerRestartStatus,
  restartComputer,
} from "#src/features/computers/computer-restart.functions";
import { listComputers, upgradeComputer } from "#src/features/computers/computers.functions";
import {
  activeUpgradingComputerIds,
  computerUpgradeStatusQuery,
  followComputerUpgrade,
  followedComputerUpgradesQuery,
  isComputerUpgradeSettled,
  upgradeRunning,
} from "#src/features/computers/computer-upgrade-status";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { getInstallOrigin } from "#src/features/install/install.functions";
import { getUserPreferences } from "#src/features/settings/settings.functions";
import { computerLabel } from "#src/features/computers/computer-identity";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/_computers")({
  loader: async ({ context, parentMatchPromise }) => {
    const [computers, parentMatch, installOrigin, desktopOrigin] = await Promise.all([
      ensureCloudComputer().then(() => listComputers()),
      parentMatchPromise,
      getInstallOrigin(),
      getCloudDesktopOrigin(),
    ]);
    const timeZone =
      parentMatch.loaderData !== undefined
        ? parentMatch.loaderData.timeZone
        : (await getUserPreferences()).timeZone;
    for (const computer of computers) {
      const activeId =
        computer.upgrade && upgradeRunning(computer.upgrade)
          ? computer.upgrade.requestId
          : undefined;
      const recoveredId =
        !activeId &&
        computer.ownedByCurrentUser &&
        computer.kind === "local" &&
        computer.upgradeProgressRequestId &&
        (!computer.upgrade || computer.upgrade.requestId === computer.upgradeProgressRequestId)
          ? computer.upgradeProgressRequestId
          : undefined;
      const requestId = activeId ?? recoveredId;
      if (requestId && !isComputerUpgradeSettled(context.queryClient, requestId))
        followComputerUpgrade(context.queryClient, {
          computerId: computer.id,
          requestId,
          startedHere: false,
        });
    }
    return {
      computers,
      timeZone,
      installOrigin,
      desktopOrigin,
    };
  },
  pendingComponent: ComputersPending,
  errorComponent: PageLoadError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers, installOrigin, desktopOrigin } = Route.useLoaderData();
  const [mountedAt] = useState(() => Date.now());
  const followedUpgrades = useQuery(followedComputerUpgradesQuery).data ?? [];
  const followedStatuses = useQueries({
    queries: followedUpgrades.map(({ computerId, requestId }) => ({
      ...computerUpgradeStatusQuery(computerId, requestId),
      enabled: false,
    })),
  });
  const upgradingKey = followedUpgrades
    .map(
      (entry, index) =>
        `${entry.computerId}:${entry.requestId}:${followedStatuses[index]?.data?.status ?? ""}:${followedStatuses[index]?.dataUpdatedAt ?? 0}`,
    )
    .join("|");
  const upgradingComputerIds = useMemo(() => {
    const terminalUpgradeRequestIds = new Set(
      computers.flatMap((computer) =>
        computer.upgrade &&
        (computer.upgrade.status === "failed" || computer.upgrade.status === "completed")
          ? [computer.upgrade.requestId]
          : [],
      ),
    );
    return activeUpgradingComputerIds(
      followedUpgrades,
      followedStatuses.map((query) => query.data),
      Date.now(),
      terminalUpgradeRequestIds,
      followedStatuses.map((query) => query.dataUpdatedAt),
      mountedAt,
    );
  }, [computers, mountedAt, upgradingKey]);
  const router = useRouter();
  const requestUpgrade = useServerFn(upgradeComputer);
  const requestRestart = useServerFn(restartComputer);
  const readRestart = useServerFn(readComputerRestartStatus);
  const releaseChannels = useMemo(
    () => [...new Set(computers.map((computer) => computer.releaseChannel ?? "latest"))],
    [computers],
  );
  const latestComputerVersions = useQueries({
    queries: releaseChannels.map((channel) => latestComputerVersionQuery(channel)),
  });
  const latestVersionKey = releaseChannels
    .map((channel, index) => `${channel}:${latestComputerVersions[index]?.data ?? ""}`)
    .join("|");
  const latestByChannel = useMemo(
    () =>
      new Map(
        releaseChannels.map((channel, index) => [
          channel,
          latestComputerVersions[index]?.data ?? null,
        ]),
      ),
    [latestVersionKey],
  );
  const { currentWorkspace } = appRoute.useLoaderData();
  const params = useParams({
    from: "/w/$workspaceSlug/_computers/computer/$computerId",
    shouldThrow: false,
  });
  const addRequested = useSearch({
    from: "/w/$workspaceSlug/_computers/computers",
    shouldThrow: false,
  })?.add;
  const [addComputerOpen, setAddComputerOpen] = useState(addRequested === 1);
  const dismissAdd = (open: boolean) => {
    setAddComputerOpen(open);
    const workspaceSlug = currentWorkspace?.slug;
    if (!open && addRequested && workspaceSlug)
      void router.navigate({
        to: "/w/$workspaceSlug/computers",
        params: { workspaceSlug },
        search: {},
        replace: true,
      });
  };
  const [connectedComputerName, setConnectedComputerName] = useState<string | null>(null);
  const computersWhenAddOpened = useRef<ReadonlySet<string> | null>(null);
  const connectionProbe = useQuery({
    queryKey: ["computers", "connection-probe", currentWorkspace?.id],
    queryFn: () => listComputerConnections(),
    enabled: addComputerOpen && !connectedComputerName,
    refetchInterval: addComputerOpen && !connectedComputerName ? 2000 : false,
    retry: false,
  });

  useEffect(() => {
    if (!addComputerOpen) {
      computersWhenAddOpened.current = null;
      setConnectedComputerName(null);
      return;
    }
    if (connectedComputerName) return;

    computersWhenAddOpened.current = new Set(computers.map((computer) => computer.id));
  }, [addComputerOpen, computers, connectedComputerName]);

  useEffect(() => {
    const initialComputerIds = computersWhenAddOpened.current;
    if (!addComputerOpen || !initialComputerIds || connectedComputerName) return;
    const connectedComputer = connectionProbe.data?.find(
      (computer) =>
        !initialComputerIds.has(computer.id) && computer.ownedByCurrentUser && computer.online,
    );
    if (!connectedComputer) return;
    setConnectedComputerName(computerLabel(connectedComputer));
    void router.invalidate({ sync: true });
  }, [addComputerOpen, connectedComputerName, connectionProbe.data, router]);

  return (
    <CloudDesktopOriginProvider origin={desktopOrigin}>
      <ComputerLayout
        computers={computers}
        selectedComputerId={params?.computerId}
        onAdd={() => setAddComputerOpen(true)}
        onUpgradeComputer={async (computerId, requestId, target) => {
          const status = await requestUpgrade({ data: { computerId, requestId, target } });
          if (status.status === "accepted") void router.invalidate();
          return status;
        }}
        onRestartComputer={(computerId, requestId) =>
          requestRestart({ data: { computerId, requestId } })
        }
        onReadRestartStatus={(computerId, requestId) =>
          readRestart({ data: { computerId, requestId } })
        }
        latestComputerVersions={latestByChannel}
        upgradingComputerIds={upgradingComputerIds}
      >
        <Outlet />
      </ComputerLayout>
      <AddComputerDialog
        open={addComputerOpen}
        onOpenChange={dismissAdd}
        installOrigin={installOrigin}
        workspaceSlug={currentWorkspace?.slug ?? null}
        connectedComputerName={connectedComputerName}
        onCreated={async (computerId) => {
          const workspaceSlug = currentWorkspace?.slug;
          setAddComputerOpen(false);
          await router.invalidate();
          if (!workspaceSlug) return;
          await router.navigate({
            to: "/w/$workspaceSlug/computer/$computerId",
            params: { workspaceSlug, computerId },
          });
        }}
      />
    </CloudDesktopOriginProvider>
  );
}
