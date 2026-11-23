import { installerRecoveryObservationSchema } from "@lrm/coforge-sdk/internal/installer-recovery-observation";
import {
  getComputerInstallerRecovery,
  type InstallerRecoveryClient,
  type InstallerRecoveryConnection,
} from "#src/server/computers/computer-installer-recovery.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import type { CentrifugoRpcMetadata } from "./rpc-types.server";

type Claim = {
  workspaceId?: string;
  computerId?: string;
  workerInstanceId?: string;
  startedAt?: number;
};

function authenticatedClient(metadata: CentrifugoRpcMetadata, claim: Claim) {
  const { client, principal } = metadata;
  if (
    rejectNonDaemonPrincipal(principal) ||
    !client ||
    principal.workspaceId !== claim.workspaceId ||
    principal.computerId !== claim.computerId ||
    !principal.workerInstanceId ||
    principal.workerInstanceId !== claim.workerInstanceId ||
    principal.connectionSequence === undefined
  )
    return undefined;
  return {
    scope: { workspaceId: principal.workspaceId, computerId: principal.computerId },
    client: {
      client,
      workerInstanceId: principal.workerInstanceId,
      connectionSequence: principal.connectionSequence,
    } satisfies InstallerRecoveryClient,
  };
}

function authenticatedConnection(metadata: CentrifugoRpcMetadata, claim: Claim) {
  const accepted = authenticatedClient(metadata, claim);
  if (!accepted || claim.startedAt === undefined || !Number.isSafeInteger(claim.startedAt))
    return undefined;
  return {
    scope: accepted.scope,
    connection: {
      ...accepted.client,
      startedAt: claim.startedAt,
    } satisfies InstallerRecoveryConnection,
  };
}

export function installerRecoveryRpc(
  store: () => Pick<
    ReturnType<typeof getComputerInstallerRecovery>,
    "ready" | "observe" | "close"
  > = getComputerInstallerRecovery,
) {
  return {
    async ready(claim: Claim, metadata: CentrifugoRpcMetadata) {
      const accepted = authenticatedConnection(metadata, claim);
      if (accepted) await store().ready(accepted.scope, accepted.connection);
    },
    async observe(
      claim: Claim & { online: boolean; installerRecoveryObservation?: unknown },
      metadata: CentrifugoRpcMetadata,
    ) {
      if (!claim.online) {
        await this.close(claim, metadata);
        return undefined;
      }
      if (claim.installerRecoveryObservation === undefined) return undefined;
      const accepted = authenticatedConnection(metadata, claim);
      if (!accepted) return undefined;
      const parsed = installerRecoveryObservationSchema.safeParse(
        claim.installerRecoveryObservation,
      );
      if (parsed.success) return store().observe(accepted.scope, accepted.connection, parsed.data);
      return undefined;
    },
    async close(claim: Claim, metadata: CentrifugoRpcMetadata) {
      const accepted = authenticatedClient(metadata, claim);
      if (accepted) await store().close(accepted.scope, accepted.client);
    },
  };
}
