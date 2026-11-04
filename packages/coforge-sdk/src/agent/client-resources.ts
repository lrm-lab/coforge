import { agentApiRoutes, workspaceInfoRoute } from "./routes";
import type { AgentActionPrepareResponse } from "./action-cards";
import type {
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendResponse,
  AgentResolveResponse,
  AgentReactionResponse,
  AgentEventsResponse,
  AgentChannelAttentionResponse,
  AgentThreadAttentionResponse,
} from "./messages";
import type {
  AgentChannelInfoResponse,
  AgentChannelMembersResponse,
  AgentChannelJoinResponse,
  AgentChannelLeaveResponse,
  AgentChannelCreateResponse,
  AgentChannelArchiveResponse,
  AgentChannelAddMemberResponse,
  AgentChannelRemoveMemberResponse,
} from "./channels";
import type { AgentManualGetResponse, AgentManualSearchResponse } from "./manual";
import type { AgentLabelListResponse } from "./labels";
import type {
  AgentReminderRequest,
  AgentReminderResponse,
  AgentTaskRequest,
  AgentTaskResponse,
} from "./types";
import type {
  AgentApiResult,
  AgentApiTransport,
  AgentAttachmentDownload,
  AgentAttachmentUploadResponse,
  AgentAttachmentUploadSessionCompleteResponse,
  AgentAttachmentUploadSessionCreateResponse,
  AgentAttachmentUploadSessionView,
  AgentReminderInput,
  AgentTaskInput,
  RawAgentApiClient,
  WorkspaceInfoResult,
} from "./client";

/** The raw Agent API client: every route, answered in its `AgentApiResult` envelope. The
 * resource factories below are the only calls the transport sees. */
export function createAgentApiRawClient(transport: AgentApiTransport): RawAgentApiClient {
  return {
    workspace: {
      info: () =>
        transport.request(workspaceInfoRoute) as Promise<AgentApiResult<WorkspaceInfoResult>>,
    },
    tasks: taskResources(transport),
    reminders: reminderResources(transport),
    labels: labelResources(transport),
    actions: actionResources(transport),
    messages: messageResources(transport),
    events: eventsResources(transport),
    manual: manualResources(transport),
    channels: {
      mute: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.mute.path(channelId)) as Promise<
          AgentApiResult<AgentChannelAttentionResponse>
        >,
      unmute: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.unmute.path(channelId)) as Promise<
          AgentApiResult<AgentChannelAttentionResponse>
        >,
      info: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.info.path(channelId)) as Promise<
          AgentApiResult<AgentChannelInfoResponse>
        >,
      members: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.members.path(channelId)) as Promise<
          AgentApiResult<AgentChannelMembersResponse>
        >,
      join: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.join.path(channelId)) as Promise<
          AgentApiResult<AgentChannelJoinResponse>
        >,
      leave: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.leave.path(channelId)) as Promise<
          AgentApiResult<AgentChannelLeaveResponse>
        >,
      create: (request) =>
        transport.request(agentApiRoutes.cloud.channels.create, request) as Promise<
          AgentApiResult<AgentChannelCreateResponse>
        >,
      update: (channelId, request) =>
        transport.request(agentApiRoutes.cloud.channels.update.path(channelId), request) as Promise<
          AgentApiResult<AgentChannelInfoResponse>
        >,
      archive: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.archive.path(channelId)) as Promise<
          AgentApiResult<AgentChannelArchiveResponse>
        >,
      unarchive: (channelId) =>
        transport.request(agentApiRoutes.cloud.channels.unarchive.path(channelId)) as Promise<
          AgentApiResult<AgentChannelArchiveResponse>
        >,
      addMember: (channelId, request) =>
        transport.request(
          agentApiRoutes.cloud.channels.addMember.path(channelId),
          request,
        ) as Promise<AgentApiResult<AgentChannelAddMemberResponse>>,
      removeMember: (channelId, request) =>
        transport.request(
          agentApiRoutes.cloud.channels.removeMember.path(channelId),
          request,
        ) as Promise<AgentApiResult<AgentChannelRemoveMemberResponse>>,
    },
    threads: {
      unfollow: (threadId) =>
        transport.request(agentApiRoutes.cloud.threads.unfollow.path(threadId)) as Promise<
          AgentApiResult<AgentThreadAttentionResponse>
        >,
    },
    attachments: {
      download: (attachmentId) =>
        transport.request(agentApiRoutes.cloud.attachments.path(attachmentId)) as Promise<
          AgentApiResult<AgentAttachmentDownload>
        >,
      upload: (form) =>
        transport.request(agentApiRoutes.cloud.attachments.upload, form) as Promise<
          AgentApiResult<AgentAttachmentUploadResponse>
        >,
      uploadSessions: {
        create: (request) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.create,
            request,
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionCreateResponse>>,
        complete: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.complete.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionCompleteResponse>>,
        cancel: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.cancel.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionView>>,
        get: (uploadId) =>
          transport.request(
            agentApiRoutes.cloud.attachmentUploadSessions.get.path(uploadId),
          ) as Promise<AgentApiResult<AgentAttachmentUploadSessionView>>,
      },
    },
  };
}

function taskResources(transport: AgentApiTransport): RawAgentApiClient["tasks"] {
  const execute = (operation: AgentTaskRequest["operation"]) => (request: AgentTaskInput) =>
    transport.request(agentApiRoutes.cloud.tasks, { ...request, operation }) as Promise<
      AgentApiResult<AgentTaskResponse>
    >;
  return {
    list: execute("list"),
    create: execute("create"),
    convert: execute("convert"),
    claim: execute("claim"),
    unclaim: execute("unclaim"),
    update: execute("update"),
  };
}

function reminderResources(transport: AgentApiTransport): RawAgentApiClient["reminders"] {
  const execute = (operation: AgentReminderRequest["operation"]) => (request: AgentReminderInput) =>
    transport.request(agentApiRoutes.cloud.reminders, {
      ...request,
      operation,
    }) as Promise<AgentApiResult<AgentReminderResponse>>;
  return {
    schedule: execute("schedule"),
    list: execute("list"),
    update: execute("update"),
    snooze: execute("snooze"),
    cancel: execute("cancel"),
    log: execute("log"),
  };
}

function labelResources(transport: AgentApiTransport): RawAgentApiClient["labels"] {
  return {
    list: () =>
      transport.request(agentApiRoutes.cloud.labels) as Promise<
        AgentApiResult<AgentLabelListResponse>
      >,
  };
}

function actionResources(transport: AgentApiTransport): RawAgentApiClient["actions"] {
  return {
    prepare: (request) =>
      transport.request(agentApiRoutes.cloud.actionPrepare, request) as Promise<
        AgentApiResult<AgentActionPrepareResponse>
      >,
  };
}

function messageResources(transport: AgentApiTransport): RawAgentApiClient["messages"] {
  return {
    read: (request) =>
      transport.request(agentApiRoutes.cloud.messages.list, request) as Promise<
        AgentApiResult<AgentHistoryResponse>
      >,
    search: (request) =>
      transport.request(agentApiRoutes.cloud.messages.search, request) as Promise<
        AgentApiResult<AgentSearchResponse>
      >,
    send: (request) =>
      transport.request(agentApiRoutes.cloud.messages.send, request) as Promise<
        AgentApiResult<AgentSendResponse>
      >,
    resolve: ({ messageId }) =>
      transport.request(agentApiRoutes.cloud.messages.resolve.path(messageId)) as Promise<
        AgentApiResult<AgentResolveResponse>
      >,
    addReaction: ({ messageId, emoji }) =>
      transport.request(agentApiRoutes.cloud.messages.reactions.path(messageId), {
        emoji,
      }) as Promise<AgentApiResult<AgentReactionResponse>>,
    removeReaction: ({ messageId, emoji }) =>
      transport.request(agentApiRoutes.cloud.messages.reactions.path(messageId), {
        emoji,
      }) as Promise<AgentApiResult<AgentReactionResponse>>,
  };
}

function eventsResources(transport: AgentApiTransport): RawAgentApiClient["events"] {
  return {
    get: (request) =>
      transport.request(agentApiRoutes.cloud.events, request) as Promise<
        AgentApiResult<AgentEventsResponse>
      >,
  };
}

function manualResources(transport: AgentApiTransport): RawAgentApiClient["manual"] {
  return {
    get: (request) =>
      transport.request(agentApiRoutes.cloud.manual.get, request) as Promise<
        AgentApiResult<AgentManualGetResponse>
      >,
    search: (request) =>
      transport.request(agentApiRoutes.cloud.manual.search, request) as Promise<
        AgentApiResult<AgentManualSearchResponse>
      >,
  };
}
