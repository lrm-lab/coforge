import { useEffect, useRef, useState } from "react";
import {
  Outlet,
  createFileRoute,
  getRouteApi,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { latestComputerVersionQuery } from "#src/features/computers/latest-version.query";
import { AddComputerDialog } from "#src/features/computers/add-computer-dialog";
import { ComputerLayout } from "#src/features/computers/computer-layout";
import { ComputersPending } from "#src/features/computers/computers-pending";
import { ensureCloudComputer } from "#src/features/computers/cloud-computers.functions";
import { listComputerConnections } from "#src/features/computers/computer-connection.functions";
import { getCloudDesktopOrigin } from "#src/features/computers/cloud-desktop-origin.functions";
import { listComputers } from "#src/features/computers/computers.functions";
import {
  followComputerUpgrade,
  upgradeRunning,
} from "#src/features/computers/computer-upgrade-status";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { getInstallOrigin } from "#src/features/install/install.functions";
import { getUserPreferences } from "#src/features/settings/settings.functions";
import { computerLabel } from "#src/features/computers/computer-identity";

const appRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/_computers")({
  loader: async ({ context }) => {
    // Creating a Workspace already starts this. Opening the page ensures it
    // again, including an attach that waited because the container was not
    // ready yet. A deployment without a cluster still shows the computers it has.
    await ensureCloudComputer();
    const [computers, preferences, installOrigin, desktopOrigin] = await Promise.all([
      listComputers(),
      getUserPreferences(),
      getInstallOrigin(),
      getCloudDesktopOrigin(),
    ]);
    // An upgrade still running is followed by the Workspace shell (`computer-upgrade-watcher.tsx`).
    for (const computer of computers)
      if (computer.upgrade && upgradeRunning(computer.upgrade))
        followComputerUpgrade(context.queryClient, {
          computerId: computer.id,
          requestId: computer.upgrade.requestId,
          startedHere: false,
        });
    return {
      computers,
      timeZone: preferences.timeZone,
      installOrigin,
      desktopOrigin,
    };
  },
  pendingComponent: ComputersPending,
  errorComponent: PageLoadError,
  component: ComputersPage,
});

function ComputersPage() {
  const { computers, installOrigin } = Route.useLoaderData();
  const router = useRouter();
  const { data: latestComputerVersion } = useQuery(latestComputerVersionQuery());
  const { currentWorkspace } = appRoute.useLoaderData();
  const params = useParams({
    from: "/w/$workspaceSlug/_computers/computer/$computerId",
    shouldThrow: false,
  });
  const addRequested = useSearch({
    from: "/w/$workspaceSlug/_computers/computers",
    shouldThrow: false,
  })?.add;
  const [addComputerOpen, setAddComputerOpen] = useState(addRequested === "1");
  // `/computers?add=1` opens the dialog once; closing it drops the parameter so the page shows
  // its usual selection.
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
    <>
      <ComputerLayout
        computers={computers}
        selectedComputerId={params?.computerId}
        onAdd={() => setAddComputerOpen(true)}
        latestComputerVersion={latestComputerVersion}
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
    </>
  );
}
