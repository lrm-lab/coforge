import { createFileRoute, getRouteApi, notFound, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ComputerDetail } from "#src/features/computers/computer-detail";
import { createAgent } from "#src/features/agents/agents.functions";
import { executeAgentControl } from "#src/features/agents/agent-control.functions";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { getComputerRuntimeCatalog } from "#src/features/computers/computers.functions";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ComputerNotFound } from "#src/features/computers/computer-not-found";
import {
  ComputerDetailLoadError,
  ComputerDetailPending,
} from "#src/features/computers/computers-pending";
import {
  readComputerRestartStatus,
  readComputerUpgradeStatus,
  restartComputer,
  scanAgentWorkspaces,
  deleteAgentWorkspace,
  deleteComputer,
  refreshComputerRuntimeCatalog,
  formatCloudComputer,
  setRuntimeVisibility,
  updateComputerDisplayName,
  upgradeComputer,
} from "#src/features/computers/computers.functions";
import { latestComputerVersionQuery } from "#src/features/computers/latest-version.query";
import { storeQueryNow } from "#src/features/cache-persistence/browser-query-cache";
import {
  agentWorkspaceScanQuery,
  type AgentWorkspaceScanSnapshot,
} from "#src/features/computers/agent-workspace-scan.query";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

export const Route = createFileRoute("/w/$workspaceSlug/_computers/computer/$computerId")({
  // The list the parent already loaded is the whole truth about which
  // Computers this Workspace has, so the miss is decided during loading —
  // where a not-found also reaches the response status — not during render.
  loader: async ({ params, parentMatchPromise }) => {
    const { loaderData } = await parentMatchPromise;
    const computer = loaderData?.computers.find((candidate) => candidate.id === params.computerId);
    if (!computer) throw notFound();
    return {
      computer,
      timeZone: loaderData?.timeZone ?? null,
    };
  },
  pendingComponent: ComputerDetailPending,
  errorComponent: ComputerDetailLoadError,
  component: ComputerDetailPage,
  notFoundComponent: ComputerNotFound,
});

function ComputerDetailPage() {
  const { computerId } = Route.useParams();
  const { computer, timeZone } = Route.useLoaderData();
  // The release-version check is a third-party request, so it is asked for after the render rather
  // than carried in the loader (see `latest-version.query.ts`).
  const { data: latestComputerVersion } = useQuery(latestComputerVersionQuery());
  // The owner's last scan of this Computer's Agent workspaces, kept across reloads; only the
  // Scan button scans (see `agent-workspace-scan.query.ts`).
  const workspaceId = workspaceRoute.useLoaderData().currentWorkspace.id;
  const workspaceScanQuery = agentWorkspaceScanQuery(workspaceId, computerId);
  const { data: lastWorkspaceScan } = useQuery({
    ...workspaceScanQuery,
    enabled: computer.ownedByCurrentUser,
  });
  const queryClient = useQueryClient();
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const setVisibility = useServerFn(setRuntimeVisibility);
  const updateDisplayName = useServerFn(updateComputerDisplayName);
  const requestRestart = useServerFn(restartComputer);
  const readRestart = useServerFn(readComputerRestartStatus);
  const requestUpgrade = useServerFn(upgradeComputer);
  const readUpgrade = useServerFn(readComputerUpgradeStatus);
  const scanWorkspaces = useServerFn(scanAgentWorkspaces);
  const deleteWorkspace = useServerFn(deleteAgentWorkspace);
  const removeComputer = useServerFn(deleteComputer);
  const formatDisk = useServerFn(formatCloudComputer);
  const create = useServerFn(createAgent);
  const executeControl = useServerFn(executeAgentControl);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const rescanRuntimes = useServerFn(refreshComputerRuntimeCatalog);

  return (
    <ComputerDetail
      key={computerId}
      computer={computer}
      timeZone={timeZone}
      onRestart={(requestId) => requestRestart({ data: { computerId, requestId } })}
      onReadRestartStatus={(requestId) => readRestart({ data: { computerId, requestId } })}
      agentWorkspaceScan={lastWorkspaceScan ?? null}
      onScanAgentWorkspaces={
        computer.ownedByCurrentUser
          ? async () => {
              const snapshot: AgentWorkspaceScanSnapshot = {
                scannedAt: Date.now(),
                workspaces: await scanWorkspaces({ data: { computerId } }),
              };
              queryClient.setQueryData(workspaceScanQuery.queryKey, snapshot);
              // Stored before the scan reads as done, so a reload right after it keeps the result
              // (a page write otherwise waits a second, and `pagehide` is best effort).
              await storeQueryNow(queryClient, workspaceScanQuery.queryKey);
            }
          : undefined
      }
      onDeleteAgentWorkspace={
        computer.ownedByCurrentUser
          ? (agentId) => deleteWorkspace({ data: { computerId, agentId } })
          : undefined
      }
      onFormatCloudComputer={
        computer.ownedByCurrentUser && computer.kind === "cloud"
          ? async (confirmName) => {
              await formatDisk({ data: { computerId, confirmName } });
            }
          : undefined
      }
      onDeleteComputer={
        computer.ownedByCurrentUser && computer.cloudSlot !== "default"
          ? async () => {
              await removeComputer({ data: { computerId } });
              await router.navigate({
                to: "/w/$workspaceSlug/computers",
                params: { workspaceSlug },
              });
            }
          : undefined
      }
      onCreateAgent={
        computer.canManageAgents
          ? (data) =>
              create({ data }).then(async (result) => {
                await router.invalidate({ sync: true });
                return result;
              })
          : undefined
      }
      onExecuteAgentControl={(data) => executeControl({ data })}
      onLoadRuntimeCatalog={(id) => loadRuntimeCatalog({ data: { computerId: id } })}
      onRescanRuntimes={
        // As the reference Computer: its creator, or whoever manages the Workspace's Computers.
        computer.ownedByCurrentUser || computer.canManageAgents
          ? async () => {
              const { status } = await rescanRuntimes({ data: { computerId } });
              await router.invalidate({ sync: true });
              return status === "refreshed";
            }
          : undefined
      }
      onSelectAgent={(agentId) =>
        void router.navigate({
          to: "/w/$workspaceSlug/members",
          params: { workspaceSlug },
          search: {
            memberType: "agent",
            owner: "all",
            profile: formatAgentProfileParam(agentId),
          },
        })
      }
      latestComputerVersion={latestComputerVersion}
      onUpgrade={(requestId) => requestUpgrade({ data: { computerId, requestId } })}
      onReadUpgradeStatus={async (requestId) => {
        const status = await readUpgrade({ data: { computerId, requestId } });
        // A completed upgrade changes the version the list and the meta line show.
        if (status.status === "completed") await router.invalidate({ sync: true });
        return status;
      }}
      onUpdateDisplayName={async (displayName) => {
        await updateDisplayName({ data: { computerId, displayName } });
        await router.invalidate({ sync: true });
      }}
      onSetRuntimePublic={async (runtimeId, isPublic) => {
        await setVisibility({ data: { runtimeId, isPublic } });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
