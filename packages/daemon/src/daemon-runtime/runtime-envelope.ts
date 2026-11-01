import { workspaceEnvelope } from "./agent-inbox-factories";

/** The fields every daemon -> server report opens with: this protocol, a fresh request id, and
 * this runtime's own Workspace and Computer. */
export function runtimeEnvelope(connection: { workspaceId: string; computerId: string }) {
  return workspaceEnvelope(connection.workspaceId, connection.computerId);
}
