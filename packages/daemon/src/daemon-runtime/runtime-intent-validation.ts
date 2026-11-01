export function assertOwnIntent(
  intent: { protocolMajor: number; workspaceId: string; computerId?: string },
  workspaceId: string,
  computerId: string,
): void {
  if (intent.protocolMajor !== 1) throw new Error("unsupported agent protocol major");
  if (intent.workspaceId !== workspaceId) throw new Error("agent intent targets another Workspace");
  if (intent.computerId !== computerId) throw new Error("agent intent targets another Computer");
}
