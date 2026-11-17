export const artifactPresenceChannel = (workspaceId: string, artifactId: string) =>
  `presence:artifact:${workspaceId}:${artifactId}`;

export const ARTIFACT_ROSTER_SIZE = 50;
