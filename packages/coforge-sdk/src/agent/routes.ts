import { APP_REGISTRATION_REQUEST_MAX_BYTES } from "./app-management";

/** Mention delivery (`coforge mention delivery`): what became of each @mention in a message the
 * Agent sent, by the message's full id or eight-hex prefix. */
const MENTION_DELIVERIES_ROUTE = {
  method: "GET",
  path: (messageId: string) =>
    `/api/agent/v1/messages/${encodeURIComponent(messageId)}/mention-deliveries`,
} as const;

/** `coforge user info`: one human or Agent by name. Same route under `proxy`, `local` and `cloud`. */
const USERS_ROUTE = {
  method: "GET",
  path: (name: string) => `/api/agent/v1/users/${encodeURIComponent(name)}`,
} as const;

/** `coforge thread list` and the unread list of `coforge inbox check`. Same routes under `proxy`, `local` and `cloud`. */
const INBOX_LIST_ROUTE = {
  method: "GET",
  path: "/api/agent/v1/inbox/conversations",
} as const;
const THREAD_LIST_ROUTE = { method: "GET", path: "/api/agent/v1/threads" } as const;

/** `coforge mention pending|execute`. Same routes under `proxy`, `local` and `cloud`. */
const MENTION_ACTIONS_ROUTES = {
  pending: { method: "GET", path: "/api/agent/v1/mention-actions/pending" },
  execute: { method: "POST", path: "/api/agent/v1/mention-actions/execute" },
} as const;

/** `coforge profile show|update`. Same routes under `proxy`, `local` and `cloud`. */
const PROFILE_ROUTES = {
  get: { method: "GET", path: "/api/agent/v1/profile" },
  update: { method: "POST", path: "/api/agent/v1/profile" },
} as const;

/** `coforge app config`: read, or change at a known revision, one of the Agent's own Apps'
 * config. Same routes under `proxy`, `local` and `cloud`. */
const appConfigPath = (appId: string) => `/api/agent/v1/apps/${encodeURIComponent(appId)}/config`;
const APP_CONFIG_ROUTES = {
  get: { method: "GET", path: appConfigPath },
  update: { method: "PATCH", path: appConfigPath },
} as const;

/** `coforge app list|token`: the Workspace's apps, and a short-lived token for one. Same routes
 * under `proxy`, `local` and `cloud`. */
const APP_ROUTES = {
  list: { method: "GET", path: "/api/agent/v1/apps" },
  token: {
    method: "POST",
    path: (appKey: string) => `/api/agent/v1/apps/${encodeURIComponent(appKey)}/token`,
  },
} as const;

/** `coforge app status|list --owned|rotate-secret`: an Agent managing the apps it registered. One
 * local route carries an `operation`; the cloud has one route for each. The card itself is
 * prepared with `actionPrepare`. */
const APP_REGISTRATION_LOCAL_ROUTE = {
  method: "POST",
  path: "/api/agent/v1/app-registrations",
  /** Room for a logo's base64 (`app logo`); the other operations are small. */
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
  // The management operations (`app-management.ts`): one route each, named like the operation.
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

/** Resumable attachment uploads. Same routes under `local` and `cloud`. */
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

/** Public Agent API route contract shared by clients and HTTP adapters. */
export const agentApiRoutes = {
  proxy: {
    workspace: { method: "GET", path: "/api/agent/v1/workspace" },
    manual: {
      get: { method: "GET", path: "/api/agent/v1/manual" },
      search: { method: "GET", path: "/api/agent/v1/manual/search" },
    },
    // Local-only: answered entirely by the Daemon's Agent proxy and never forwarded to Web/backend
    // (`coforge version`).
    version: { method: "GET", path: "/api/agent/v1/version" },
    messages: { method: "POST", path: "/api/agent/v1/messages" },
    // Local-only, like `version`: `DaemonRuntime.inbox()` assembles the answer from the Agent's own
    // state (message attention plus the app inbox) and never forwards it to Web/backend. It also
    // takes no key argument, unlike the runtime methods that do reach Web.
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
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    memoryDisposition: { method: "POST", path: "/api/agent/v1/memory-dispositions" },
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    profile: PROFILE_ROUTES,
    threadList: THREAD_LIST_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
    appConfig: APP_CONFIG_ROUTES,
    apps: APP_ROUTES,
    appRegistrations: APP_REGISTRATION_LOCAL_ROUTE,
  },
  local: {
    messages: {
      method: "POST",
      path: "/api/agent/v1/messages",
    },
    // Local-only, like `version`; see the same entry under `proxy`.
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
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    memoryDisposition: { method: "POST", path: "/api/agent/v1/memory-dispositions" },
    attachments: {
      method: "GET",
      /** Served by Web ahead of the id route: what a client may upload, and whether it uploads
       * directly. It was reachable before this declaration only because the proxy forwards any
       * segment after the attachment prefix as an opaque id. */
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: ATTACHMENT_UPLOAD_SESSION_ROUTES,
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    profile: PROFILE_ROUTES,
    threadList: THREAD_LIST_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
    appConfig: APP_CONFIG_ROUTES,
    apps: APP_ROUTES,
    appRegistrations: APP_REGISTRATION_LOCAL_ROUTE,
  },
  cloud: {
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
    openviking: { method: "POST", path: "/api/agent/v1/openviking" },
    memoryDisposition: { method: "POST", path: "/api/agent/v1/memory-dispositions" },
    attachments: {
      method: "GET",
      collectionPath: "/api/agent/v1/attachments",
      /** Served by Web ahead of the id route; see the same entry under `proxy`. */
      capabilities: { method: "GET", path: "/api/agent/v1/attachments/capabilities" },
      path: (attachmentId: string) =>
        `/api/agent/v1/attachments/${encodeURIComponent(attachmentId)}`,
      upload: { method: "POST", path: "/api/agent/v1/attachments" },
    },
    attachmentUploadSessions: ATTACHMENT_UPLOAD_SESSION_ROUTES,
    users: USERS_ROUTE,
    mentionActions: MENTION_ACTIONS_ROUTES,
    mentionDeliveries: MENTION_DELIVERIES_ROUTE,
    profile: PROFILE_ROUTES,
    threadList: THREAD_LIST_ROUTE,
    inboxList: INBOX_LIST_ROUTE,
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
