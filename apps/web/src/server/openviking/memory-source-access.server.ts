import type { OpenVikingPolicyGateway } from "./policy-gateway.server";

/** Current source ACL only: do not redo discovery eligibility or inspect hint text. */
export function createMemorySourceAccess({
  bindings,
  gateway,
}: {
  bindings: { get(workspaceId: string): Promise<{ accountId: string } | null> };
  gateway: OpenVikingPolicyGateway;
}) {
  return async (
    workspaceId: string,
    agentId: string,
    source: { accountId: string; uri: string },
  ): Promise<boolean> => {
    const binding = await bindings.get(workspaceId);
    if (!binding || binding.accountId !== source.accountId) return false;
    const result = await gateway.forward(
      { kind: "agent", agentId },
      {
        workspaceId,
        method: "GET",
        path: "/api/v1/fs/stat",
        query: { uri: source.uri },
      },
    );
    if (!result.ok) {
      if (result.failure.code === "capability_denied") return false;
      throw new Error("Memory source authorization is unavailable");
    }
    await result.response.body.cancel();
    if ([403, 404].includes(result.response.status)) return false;
    if (result.response.status < 200 || result.response.status >= 300)
      throw new Error("Memory source authorization is unavailable");
    return true;
  };
}
