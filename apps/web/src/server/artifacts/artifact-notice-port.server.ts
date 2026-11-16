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

export type ArtifactNoticePort = {
  deliver(notice: ArtifactNotice): Promise<void>;
};
