import type { CentrifugoRpcMetadata } from "./rpc-handler.server";

/** A daemon RPC must come from the Computer it claims to speak for. The 403 to return if not. */
export function requireDaemonPrincipal(
  metadata: CentrifugoRpcMetadata,
  claim: { workspaceId: string; computerId: string },
) {
  if (
    !metadata.principal.userId ||
    metadata.principal.workspaceId !== claim.workspaceId ||
    metadata.principal.computerId !== claim.computerId
  )
    return { code: 403, message: "daemon runtime identity is not authorized" };
  return undefined;
}
