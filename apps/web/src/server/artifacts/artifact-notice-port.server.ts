import type { DatabaseScope } from "#src/server/db/transaction.server";

export type NoticeLine = { label: string; value: string; untrusted?: true };

export type ArtifactNoticeContent = {
  headline: string;
  lines: readonly NoticeLine[];
  next: string;
};

export type ArtifactNotice = {
  workspaceId: string;
  agentId: string;
  key: string;
  content: ArtifactNoticeContent;
};

export type StagedArtifactNotice = { agentId: string; deliveryId: string; push(): Promise<void> };

export type ArtifactNoticePort = {
  deliver(notice: ArtifactNotice): Promise<void>;
  stage(scope: DatabaseScope, notice: ArtifactNotice): Promise<StagedArtifactNotice | undefined>;
};
