import type {
  AgentAppConfigPatch,
  AgentAppConfigResponse,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  AgentManualGetResponse,
  AgentManualSearchResponse,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingResponse,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentThreadListResponse,
  AgentUserInfoResponse,
  AgentVersionResponse,
  GitHubCredentialResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  MentionSelectorInput as MentionSelector,
  ChannelCommand,
  TaskCommand,
  TaskResult,
  WeeklyReportCommand,
  WeeklyReportResponse,
} from "@lrm/coforge-sdk/internal";
import type { ActionCardAction } from "@lrm/coforge-sdk/agent";
import type { ActionPrepareResult } from "#src/action-prepare-run";
import type { ArtifactTransport } from "#src/artifact-commands";
import type { InboxTransport } from "#src/inbox-check";
import type { LabelTransport } from "#src/label-commands";
import type { ReminderResponse, ReminderTransportRequest } from "#src/reminder-commands";
import type { TaskConversationTransport } from "#src/task-conversation-run";
import type { WorkspaceInfoResult } from "#src/workspace-info";
import type { MessageCheckResult } from "#src/message-check-format";
import type { MessageReadOptions } from "#src/message-read-args";
import type { MessageSearchOptions } from "#src/message-search-args";
import type {
  WeeklyReportCollectCommand,
  WeeklyReportCollectResult,
} from "#src/weekly-report-collect";
import type {
  WeeklyReportKeyPointsCommand,
  WeeklyReportKeyPointsResult,
  WeeklyReportMemoryCommand,
  WeeklyReportMemoryResult,
} from "../index";

export type MessageTransport = LabelTransport & {
  check(target?: string): Promise<MessageCheckResult>;
  read(target: string, options?: MessageReadOptions): Promise<unknown>;
  search?(options: MessageSearchOptions): Promise<unknown>;
  send(
    target: string,
    body?: string,
    options?: {
      sendDraft?: boolean;
      expectedDraftKey?: string;
      continueAnyway?: boolean;
      freshnessContextMode?: "withheld";
      attachmentIds?: string[];
      mentions?: MentionSelector[];
      targetConfirmed?: boolean;
    },
  ): Promise<unknown>;
  continue?(continuationId: string, choice: "a" | "b" | "c" | "d", body?: string): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
  attachmentComments?(
    request: AgentAttachmentCommentsRequest,
  ): Promise<AgentAttachmentCommentsResponse>;
  upload?(input: {
    path: string;
    target: string;
    mimeType?: string;
  }): Promise<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
  resolve?(messageId: string): Promise<unknown>;
  react?(messageId: string, emoji: string, remove?: boolean): Promise<unknown>;
  inboxCheck?(): Promise<unknown>;
  inboxList?: InboxTransport["inboxList"];
  setChannelMuted?(target: string, muted: boolean): Promise<unknown>;
  reminder?(request: ReminderTransportRequest): Promise<ReminderResponse>;
  artifact?: ArtifactTransport["artifact"];
  setThreadFollowed?(target: string, followed: boolean): Promise<unknown>;
  threadList?(): Promise<AgentThreadListResponse>;
  channel?(command: Omit<ChannelCommand, "idempotencyKey">): Promise<unknown>;
  task?(command: TaskCommand): Promise<TaskResult>;
  taskConversation?: TaskConversationTransport["taskConversation"];
  workspaceInfo?(): Promise<WorkspaceInfoResult>;
  weeklyReport?(command: WeeklyReportCommand): Promise<WeeklyReportResponse>;
  weeklyReportCollect?(command: WeeklyReportCollectCommand): Promise<WeeklyReportCollectResult>;
  weeklyReportKeyPoints?(
    command: WeeklyReportKeyPointsCommand,
  ): Promise<WeeklyReportKeyPointsResult>;
  weeklyReportMemory?(command: WeeklyReportMemoryCommand): Promise<WeeklyReportMemoryResult>;
  githubCredential?(): Promise<GitHubCredentialResponse>;
  /** Server-decided `Co-authored-by` trailers for `coforge git prepare-commit-msg`; never built by
   * the CLI itself. */
  githubCommitTrailers?(repository: string | null): Promise<string[]>;
  actionPrepare?(target: string, action: ActionCardAction): Promise<ActionPrepareResult>;
  manualGet?(topic: string, intent: string, reason: string): Promise<AgentManualGetResponse>;
  manualSearch?(query: string, intent: string, reason: string): Promise<AgentManualSearchResponse>;
  /** `coforge version`'s local-only Daemon query; never reaches Web/backend. */
  version?(): Promise<AgentVersionResponse>;
  contextSearch?(request: {
    messageId: string;
    sessionId: string;
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<import("@lrm/coforge-sdk/agent").AgentContextQueryResponse>;
  contextRead?(request: {
    messageId: string;
    sessionId: string;
    around: string;
    limit?: number;
    page?: number;
  }): Promise<import("@lrm/coforge-sdk/agent").AgentContextQueryResponse>;
  userInfo?(name: string): Promise<AgentUserInfoResponse>;
  profileShow?(target?: string): Promise<AgentProfileShowResponse>;
  profileUpdate?(input: AgentProfileUpdateRequest): Promise<AgentProfileUpdateResponse>;
  /** One of the calling Agent's own Apps' config (`coforge app config`). */
  appConfigGet?(appId: string): Promise<AgentAppConfigResponse>;
  /** A change to it, refused unless the config is still at `change.expectedRevision`. */
  appConfigUpdate?(appId: string, change: AgentAppConfigPatch): Promise<AgentAppConfigResponse>;
  /** The calling Agent's mentions that reached no one (`coforge mention pending`). */
  mentionPending?(limit?: number): Promise<AgentMentionPendingResponse>;
  /** Acts on pending mentions by resolution id (`coforge mention notify|add`). */
  mentionExecute?(request: AgentMentionExecuteRequest): Promise<AgentMentionExecuteResponse>;
  /** What became of each @mention in a message the calling Agent sent (`coforge mention
   * delivery`). */
  mentionDelivery?(messageId: string): Promise<AgentMentionDeliveryResponse>;
};
