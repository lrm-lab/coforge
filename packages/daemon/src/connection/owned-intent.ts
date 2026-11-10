/** An intent this Workspace's daemon may act on: protocol major 1, addressed to this Workspace. */
export function ownedIntent<Intent extends { protocolMajor: number; workspaceId: string }>(
  intent: Intent,
  workspaceId: string,
): Intent {
  if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
    throw new Error("agent intent targets another Workspace");
  return intent;
}
