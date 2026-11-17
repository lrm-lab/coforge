import {
  type MentionSelectorInput as MentionSelector,
  type WeeklyReportCommand,
  type WeeklyReportMemoryCommand,
  type WeeklyReportMemoryResult,
} from "@lrm/coforge-sdk/internal";
import { type AgentMentionActionKind } from "@lrm/coforge-sdk/agent";
import { type WhoamiInvocation, type WhoamiResult } from "#src/whoami";
import { type ProfileUpdateInvocation } from "#src/profile-update";
import { type AttachmentViewInvocation } from "#src/attachment-view-args";
import { type UserInfoInvocation } from "#src/user-info";
import {
  type WorkspaceInfoInvocation,
  type WorkspaceInfoOptions,
  type WorkspaceInfoResult,
} from "#src/workspace-info";
import { type MessageSearchOptions } from "#src/message-search-args";
import { type MessageReadOptions } from "#src/message-read-args";
import { type MentionPendingInvocation } from "#src/mention-pending";
import {
  type ChannelInvocation,
  type InboxInvocation,
  type ThreadInvocation,
} from "#src/attention-args";
import type { ActionPrepareResult } from "#src/action-prepare-run";

export type { WhoamiInvocation, WhoamiResult, ProfileUpdateInvocation };

export type { ContextInvocation } from "#src/context-commands";

export type { UserInfoInvocation };

export type { WorkspaceInfoInvocation, WorkspaceInfoOptions, WorkspaceInfoResult };

export type { MessageSearchOptions };

export type { ChannelInvocation, InboxInvocation, ThreadInvocation };

export type { LabelInvocation } from "#src/label-commands";
export type { ProcInvocation } from "#src/proc-commands";

export { createAgentApiClient } from "@lrm/coforge-sdk/agent";

export type MessageCommand =
  | "check"
  | "read"
  | "search"
  | "send"
  | "continue"
  | "resolve"
  | "react";

export type MessageInvocation =
  | { command: "check"; target?: string }
  | ({ command: "read"; target: string } & MessageReadOptions)
  | ({ command: "search" } & MessageSearchOptions)
  | {
      command: "send";
      target: string;
      sendDraft?: boolean;
      discardDraft?: boolean;
      /** `--send-draft` / `--discard-draft` only: refuse unless the draft still belongs to this key. */
      expectedDraftKey?: string;
      continueAnyway?: boolean;
      freshnessContextMode?: "withheld";
      json?: boolean;
      attachmentIds?: string[];
      mentions?: MentionSelector[];
      targetConfirmed?: boolean;
    }
  | {
      /** Answers a held send's continuation: `a` resends the draft, `b` replaces its body from
       * stdin, `c` discards it, `d` forces the resend anyway. */
      command: "continue";
      continuationId: string;
      continuationChoice: "a" | "b" | "c" | "d";
      json?: boolean;
    }
  | { command: "resolve"; messageId: string }
  | { command: "react"; messageId: string; emoji: string; remove?: true };

export type AttachmentInvocation = AttachmentViewInvocation;

export type AttachmentUploadInvocation = {
  command: "attachment.upload";
  path?: string;
  target?: string;
  mimeType?: string;
  json?: boolean;
};

export type { ChannelManagementInvocation } from "./src/channel-args";

export type {
  ReminderInvocation,
  ReminderResponse,
  ReminderTransportRequest,
} from "#src/reminder-commands";

export { resolveReminderId } from "#src/reminder-commands";

export type WeeklyReportInvocation =
  | {
      command: "weekly-report";
      weeklyReport: WeeklyReportCommand;
    }
  | { command: "weekly-report"; inputPath: string };

export type {
  WeeklyReportCollectCommand,
  WeeklyReportCollectInvocation,
  WeeklyReportCollectResult,
} from "#src/weekly-report-collect";

export type WeeklyReportKeyPointsCommand = {
  idempotencyKey: string;
  reportId: string;
  markdown: string;
};

export type WeeklyReportKeyPointsResult = {
  idempotencyKey: string;
  reportId: string;
  status: string;
};

export type WeeklyReportKeyPointsInvocation = {
  command: "weekly-report-key-points";
  keyPoints: WeeklyReportKeyPointsCommand;
  /** When set, `run` loads this file into `keyPoints.markdown` before posting. */
  markdownPath?: string;
};

export type { WeeklyReportMemoryCommand, WeeklyReportMemoryResult };

export type WeeklyReportMemoryInvocation = {
  command: "weekly-report-memory";
  filePath: string;
  memory: Pick<WeeklyReportMemoryCommand, "idempotencyKey" | "reportId">;
};

export type ActionPrepareInvocation = { command: "action-prepare"; target: string };
export type {
  ActionWithdrawInvocation,
  InboxDismissInvocation,
  InboxReadInvocation,
} from "#src/inbox-commands";

export type { ActionPrepareResult };

export type ManualInvocation =
  | { command: "manual-get"; topic: string; intent: string; reason: string }
  | { command: "manual-search"; query: string; intent: string; reason: string };

export type VersionInvocation = { command: "version"; json?: boolean };

export type ProfileShowInvocation = {
  command: "profile-show";
  target?: string;
  json?: boolean;
};

export type MentionInvocation =
  | MentionPendingInvocation
  | { command: "mention-delivery"; messageId: string; json?: boolean }
  | {
      command: "mention-action";
      action: AgentMentionActionKind;
      resolutionIds: string[];
      json?: boolean;
    };

export type { MessageTransport } from "#src/message-transport";

export { parseArgs } from "#src/parse-args";
export { run } from "#src/command-run";
