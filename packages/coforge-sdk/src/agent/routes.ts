import { APP_REGISTRATION_REQUEST_MAX_BYTES } from "./app-management";
import { TEAM_MEMORY_ROUTE } from "./team-memory";
import { ARTIFACT_REQUEST_MAX_BYTES, ARTIFACT_UPLOAD_MAX_BYTES } from "./artifacts";
import { PROC_START_MAX_BODY_BYTES } from "./proc";
const MENTION_DELIVERIES_ROUTE = {
  method: "GET",
  path: (messageId: string) =>
    `/api/agent/v1/messages/${encodeURIComponent(messageId)}/mention-deliveries`,
} as const;
const ATTACHMENT_COMMENTS_ROUTE = {
  method: "GET",
  path: (attachmentId: string) =>
    `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}/comments`,
} as const;
const USERS_ROUTE = {
  method: "GET",
  path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
} as const;
const LABELS_ROUTE = {
  method: "GET",
  path: "/api/agent/v1/labels",
} as const;
const LABEL_WRITE_ROUTE = {
  method: "POST",
  path: "/api/agent/v1/labels",
} as const;
const INBOX_LIST_ROUTE = {
  method: "GET",
  path: "/api/agent/v1/inbox/conversations",
} as const;
const TASK_CONVERSATION_ROUTES = {
  view: { method: "GET", path: "/api/agent/v1/tasks/view" },
  read: { method: "GET", path: "/api/agent/v1/tasks/read" },
  following: { method: "GET", path: "/api/agent/v1/tasks/following" },
  reply: { method: "POST", path: "/api/agent/v1/tasks/reply" },
  follow: { method: "POST", path: "/api/agent/v1/tasks/follow" },
  unfollow: { method: "POST", path: "/api/agent/v1/tasks/unfollow" },
} as const;
const TASK_IDLE_NUDGE_ROUTE = { method: "POST", path: "/api/agent/v1/tasks/idle-nudge" } as const;
const THREAD_LIST_ROUTE = { method: "GET", path: "/api/agent/v1/threads" } as const;
const THREAD_FOLLOW_ROUTE = {
  method: "POST",
  path: (threadId: string) => `/api/agent/v1/threads/${encodeURIComponent(threadId)}/follow`,
} as const;
const GUIDANCE_ROUTE = { method: "POST", path: "/api/agent/v1/guidance" } as const;
const ARTIFACTS_ROUTE = {
  method: "POST",
  path: "/api/agent/v1/artifacts",
  maxBodyBytes: ARTIFACT_REQUEST_MAX_BYTES,
} as const;
const ARTIFACT_FILE_ROUTES = {
  upload: {
    method: "PUT",
    path: (sha256: string) => `/api/agent/v1/artifacts/uploads/${encodeURIComponent(sha256)}`,
    maxBodyBytes: ARTIFACT_UPLOAD_MAX_BYTES,
  },
  download: {
    method: "GET",
    path: (artifact: string, filePath: string) =>
      `/api/agent/v1/artifacts/${encodeURIComponent(artifact)}/files/${encodeURIComponent(filePath)}`,
  },
} as const;
const MENTION_ACTIONS_ROUTES = {
  pending: { method: "GET", path: "/api/agent/v1/mention-actions/pending" },
  execute: { method: "POST", path: "/api/agent/v1/mention-actions/execute" },
} as const;
const PROFILE_ROUTES = {
  get: { method: "GET", path: "/api/agent/v1/profile" },
  update: { method: "POST", path: "/api/agent/v1/profile" },
} as const;
const appConfigPath = (appId: string) => `/api/agent/v1/apps/${encodeURIComponent(appId)}/config`;
const APP_CONFIG_ROUTES = {
  get: { method: "GET", path: appConfigPath },
  update: { method: "PATCH", path: appConfigPath },
} as const;
const APP_ROUTES = {
  list: { method: "GET", path: "/api/agent/v1/apps" },
  marketplace: { method: "GET", path: "/api/agent/v1/apps/marketplace" },
  token: {
    method: "POST",
    path: (appKey: string) => `/api/agent/v1/apps/${encodeURIComponent(appKey)}/token`,
  },
} as const;
const APP_REGISTRATION_LOCAL_ROUTE = {
  method: "POST",
  path: "/api/agent/v1/app-registrations",
  maxBodyBytes: APP_REGISTRATION_REQUEST_MAX_BYTES,
} as const;
const ownedAppPath = (clientKey: string, suffix = "") =>
  `/api/agent/v1/apps/owned/${encodeURIComponent(clientKey)}${suffix}`;
const APP_REGISTRATION_CLOUD_ROUTES = {
  status: { method: "GET", path: "/api/agent/v1/apps/registrations/status" },
  owned: { method: "GET", path: "/api/agent/v1/apps/owned" },
  rotateSecret: {
    method: "POST",
    path: (clientKey: string) => ownedAppPath(clientKey, "/rotate-secret"),
  },
  update: { method: "PATCH", path: (clientKey: string) => ownedAppPath(clientKey) },
  delete: { method: "DELETE", path: (clientKey: string) => ownedAppPath(clientKey) },
  logoSet: { method: "PUT", path: (clientKey: string) => ownedAppPath(clientKey, "/logo") },
  logoClear: { method: "DELETE", path: (clientKey: string) => ownedAppPath(clientKey, "/logo") },
  transferOwner: {
    method: "POST",
    path: (clientKey: string) => ownedAppPath(clientKey, "/transfer-owner"),
  },
  shareLinkCreate: {
    method: "POST",
    path: (clientKey: string) => ownedAppPath(clientKey, "/share-link"),
  },
  shareLinkStatus: {
    method: "GET",
    path: (clientKey: string) => ownedAppPath(clientKey, "/share-link"),
  },
  shareLinkRevoke: {
    method: "DELETE",
    path: (clientKey: string) => ownedAppPath(clientKey, "/share-link"),
  },
  requestPublish: {
    method: "POST",
    path: (clientKey: string) => ownedAppPath(clientKey, "/publish-request"),
  },
  requestUnpublish: {
    method: "POST",
    path: (clientKey: string) => ownedAppPath(clientKey, "/unpublish-request"),
  },
} as const;
const ATTACHMENT_UPLOAD_SESSION_ROUTES = {
  create: { method: "POST", path: "/api/agent/v1/attachment-upload-sessions" },
  complete: {
    method: "POST",
    path: (uploadId: string) =>
      `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}/complete`,
  },
  cancel: {
    method: "DELETE",
    path: (uploadId: string) =>
      `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
  },
  get: {
    method: "GET",
    path: (uploadId: string) =>
      `/api/agent/v1/attachment-upload-sessions/${encodeURIComponent(uploadId)}`,
  },
} as const;
const PROC_ROUTES = {
  list: { method: "GET", path: "/api/agent/v1/proc" },
  logs: { method: "GET", path: "/api/agent/v1/proc/logs" },
  start: {
    method: "POST",
    path: "/api/agent/v1/proc/start",
    maxBodyBytes: PROC_START_MAX_BODY_BYTES,
  },
  stop: { method: "POST", path: "/api/agent/v1/proc/stop" },
} as const;

export const agentApiRoutes = {
  proxy: {
    workspace: { method: "GET", path: "/api/agent/v1/workspace" },
    agentContext: { method: "GET", path: "/api/agent/v1/context" },
    credentialSelfRevoke: { method: "POST", path: "/api/agent/v1/credentials/self/revoke" },
    computerUpdateNotice: { method: "GET", path: "/api/agent/v1/computer-update-notice" },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    version: { method: "GET", path: "/api/agent/v1/version" },
    context: {
      search: { method: "GET", path: "/api/agent/v1/context/search" },
      read: { method: "GET", path: "/api/agent/v1/context/read" },
    },
    messages: { method: "POST", path: "/api/agent/v1/messages" },
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    weeklyReportMemory: { method: "POST", path: "/api/agent/v1/weekly-report-memory" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    attachmentComments: ATTACHMENT_COMMENTS_ROUTE,
    profile: PROFILE_ROUTES,
    taskConversations: TASK_CONVERSATION_ROUTES,
    taskIdleNudge: TASK_IDLE_NUDGE_ROUTE,
    threadList: THREAD_LIST_ROUTE,
    threadFollow: THREAD_FOLLOW_ROUTE,
    guidance: GUIDANCE_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
    labels: LABELS_ROUTE,
    labelWrite: LABEL_WRITE_ROUTE,
    artifacts: ARTIFACTS_ROUTE,
    artifactFiles: ARTIFACT_FILE_ROUTES,
    appConfig: APP_CONFIG_ROUTES,
    apps: APP_ROUTES,
    appRegistrations: APP_REGISTRATION_LOCAL_ROUTE,
    proc: PROC_ROUTES,
  },
  local: {
    messages: {
      method: "POST",
      path: "/api/agent/v1/messages",
    },
    inbox: { method: "POST", path: "/api/agent/v1/inbox" },
    context: {
      search: { method: "GET", path: "/api/agent/v1/context/search" },
      read: { method: "GET", path: "/api/agent/v1/context/read" },
    },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    weeklyReportMemory: { method: "POST", path: "/api/agent/v1/weekly-report-memory" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    channels: { method: "POST", path: "/api/agent/v1/channels" },
    attachments: {
      method: "GET",
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: ATTACHMENT_UPLOAD_SESSION_ROUTES,
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    attachmentComments: ATTACHMENT_COMMENTS_ROUTE,
    profile: PROFILE_ROUTES,
    taskConversations: TASK_CONVERSATION_ROUTES,
    taskIdleNudge: TASK_IDLE_NUDGE_ROUTE,
    threadList: THREAD_LIST_ROUTE,
    threadFollow: THREAD_FOLLOW_ROUTE,
    guidance: GUIDANCE_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
    labels: LABELS_ROUTE,
    labelWrite: LABEL_WRITE_ROUTE,
    artifacts: ARTIFACTS_ROUTE,
    artifactFiles: ARTIFACT_FILE_ROUTES,
    appConfig: APP_CONFIG_ROUTES,
    apps: APP_ROUTES,
    appRegistrations: APP_REGISTRATION_LOCAL_ROUTE,
    proc: PROC_ROUTES,
  },
  cloud: {
    teamMemory: TEAM_MEMORY_ROUTE,
    workspace: { info: { method: "GET", path: "/api/agent/v1/workspace" } },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    events: { method: "GET", path: "/api/agent/v1/events" },
    messages: {
      list: { method: "GET", path: "/api/agent/v1/messages" },
      search: { method: "GET", path: "/api/agent/v1/messages/search" },
      send: { method: "POST", path: "/api/agent/v1/messages" },
      resolve: {
        method: "GET",
        path: (messageId: string) =>
          `/api/agent/v1/messages/${encodeURIComponent(messageId)}/resolve`,
      },
      reactions: {
        path: (messageId: string) =>
          `/api/agent/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        add: { method: "POST" },
        remove: { method: "DELETE" },
      },
    },
    channels: {
      mute: {
        method: "POST",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}/mute`,
      },
      unmute: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/unmute`,
      },
      create: { method: "POST", path: "/api/agent/v1/channels" },
      info: {
        method: "GET",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}`,
      },
      update: {
        method: "PATCH",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}`,
      },
      members: {
        method: "GET",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      addMember: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      removeMember: {
        method: "DELETE",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/members`,
      },
      join: {
        method: "POST",
        path: (channelId: string) => `/api/agent/v1/channels/${encodeURIComponent(channelId)}/join`,
      },
      leave: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/leave`,
      },
      archive: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/archive`,
      },
      unarchive: {
        method: "POST",
        path: (channelId: string) =>
          `/api/agent/v1/channels/${encodeURIComponent(channelId)}/unarchive`,
      },
    },
    threads: {
      follow: THREAD_FOLLOW_ROUTE,
      unfollow: {
        method: "POST",
        path: (threadId: string) =>
          `/api/agent/v1/threads/${encodeURIComponent(threadId)}/unfollow`,
      },
    },
    reminders: { method: "POST", path: "/api/agent/v1/reminders" },
    tasks: { method: "POST", path: "/api/agent/v1/tasks" },
    actionPrepare: { method: "POST", path: "/api/agent/v1/actions/prepare" },
    weeklyReports: { method: "POST", path: "/api/agent/v1/weekly-reports" },
    weeklyReportCollect: { method: "POST", path: "/api/agent/v1/weekly-report-collect" },
    weeklyReportKeyPoints: { method: "POST", path: "/api/agent/v1/weekly-report-key-points" },
    weeklyReportMemory: { method: "POST", path: "/api/agent/v1/weekly-report-memory" },
    githubCredentials: { method: "POST", path: "/api/agent/v1/github-credentials" },
    githubCommitTrailers: { method: "POST", path: "/api/agent/v1/github-commit-trailers" },
    attachments: {
      method: "GET",
      collectionPath: "/api/agent/v1/attachments",
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: ATTACHMENT_UPLOAD_SESSION_ROUTES,
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    attachmentComments: ATTACHMENT_COMMENTS_ROUTE,
    profile: PROFILE_ROUTES,
    taskConversations: TASK_CONVERSATION_ROUTES,
    taskIdleNudge: TASK_IDLE_NUDGE_ROUTE,
    threadList: THREAD_LIST_ROUTE,
    threadFollow: THREAD_FOLLOW_ROUTE,
    guidance: GUIDANCE_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
    labels: LABELS_ROUTE,
    labelWrite: LABEL_WRITE_ROUTE,
    artifacts: ARTIFACTS_ROUTE,
    artifactFiles: ARTIFACT_FILE_ROUTES,
    appConfig: APP_CONFIG_ROUTES,
    apps: APP_ROUTES,
    appRegistrations: APP_REGISTRATION_CLOUD_ROUTES,
  },
  workspace: {
    info: {
      key: "workspaceInfo",
      method: "GET",
      path: "/api/agent/v1/workspace",
    },
  },
  external: {
    wakeHints: { method: "GET", path: "/api/agent/v1/wake-hints" },
    wakeHintsStream: { method: "GET", path: "/api/agent/v1/wake-hints/stream" },
    pushWebhook: {
      get: { method: "GET", path: "/api/agent/v1/push-webhook" },
      put: { method: "PUT", path: "/api/agent/v1/push-webhook" },
      remove: { method: "DELETE", path: "/api/agent/v1/push-webhook" },
    },
    activity: { method: "POST", path: "/api/agent/v1/activity" },
  },
  manual: {
    get: {
      key: "manualGet",
      method: "GET",
      path: "/api/agent/v1/manual",
    },
    search: {
      key: "manualSearch",
      method: "GET",
      path: "/api/agent/v1/manual/search",
    },
  },
} as const;
export const workspaceInfoRoute = agentApiRoutes.workspace.info;
