const API = "/api/agent/v1";

type Route = { feature: string; methods: readonly string[]; path: RegExp };

const ID = "[^/%]+";

const ROUTES: readonly Route[] = [
  { feature: "messages", methods: ["GET", "POST"], path: /^\/messages$/ },
  { feature: "messages", methods: ["GET"], path: /^\/messages\/search$/ },
  { feature: "messages", methods: ["GET"], path: new RegExp(`^/messages/${ID}/resolve$`) },
  {
    feature: "messages",
    methods: ["GET"],
    path: new RegExp(`^/messages/${ID}/mention-deliveries$`),
  },
  {
    feature: "messages",
    methods: ["POST", "DELETE"],
    path: new RegExp(`^/messages/${ID}/reactions$`),
  },
  { feature: "threads", methods: ["GET"], path: /^\/threads$/ },
  { feature: "threads", methods: ["POST"], path: new RegExp(`^/threads/${ID}/unfollow$`) },
  { feature: "channels", methods: ["POST"], path: /^\/channels$/ },
  { feature: "channels", methods: ["GET", "PATCH"], path: new RegExp(`^/channels/${ID}$`) },
  {
    feature: "channels",
    methods: ["POST"],
    path: new RegExp(`^/channels/${ID}/(archive|join|leave|mute|unarchive|unmute)$`),
  },
  {
    feature: "channels",
    methods: ["GET", "POST", "DELETE"],
    path: new RegExp(`^/channels/${ID}/members$`),
  },
  { feature: "tasks", methods: ["POST"], path: /^\/tasks$/ },
  { feature: "tasks", methods: ["POST"], path: /^\/tasks\/(follow|reply|unfollow|idle-nudge)$/ },
  { feature: "tasks", methods: ["GET"], path: /^\/tasks\/(following|read|view)$/ },
  { feature: "actions", methods: ["POST"], path: /^\/actions\/prepare$/ },
  { feature: "attachments", methods: ["POST"], path: /^\/attachments$/ },
  { feature: "attachments", methods: ["GET"], path: /^\/attachments\/capabilities$/ },
  { feature: "attachments", methods: ["GET"], path: new RegExp(`^/attachments/${ID}$`) },
  { feature: "attachments", methods: ["GET"], path: new RegExp(`^/attachments/${ID}/comments$`) },
  {
    feature: "attachment-upload-sessions",
    methods: ["POST"],
    path: /^\/attachment-upload-sessions$/,
  },
  {
    feature: "attachment-upload-sessions",
    methods: ["GET", "DELETE"],
    path: new RegExp(`^/attachment-upload-sessions/${ID}$`),
  },
  {
    feature: "attachment-upload-sessions",
    methods: ["POST"],
    path: new RegExp(`^/attachment-upload-sessions/${ID}/complete$`),
  },
  { feature: "artifacts", methods: ["POST"], path: /^\/artifacts$/ },
  { feature: "artifacts", methods: ["PUT"], path: new RegExp(`^/artifacts/uploads/${ID}$`) },
  { feature: "artifacts", methods: ["GET"], path: new RegExp(`^/artifacts/${ID}/files/[^/]+$`) },
  { feature: "labels", methods: ["GET", "POST"], path: /^\/labels$/ },
  { feature: "users", methods: ["GET"], path: new RegExp(`^/users/${ID}$`) },
  { feature: "profile", methods: ["GET", "POST"], path: /^\/profile$/ },
  { feature: "workspace", methods: ["GET"], path: /^\/workspace$/ },
  { feature: "manual", methods: ["GET"], path: /^\/manual$/ },
  { feature: "manual", methods: ["GET"], path: /^\/manual\/search$/ },
  { feature: "events", methods: ["GET"], path: /^\/events$/ },
  { feature: "inbox", methods: ["GET"], path: /^\/inbox\/conversations$/ },
  { feature: "wake-hints", methods: ["GET"], path: /^\/wake-hints$/ },
  { feature: "wake-hints", methods: ["GET"], path: /^\/wake-hints\/stream$/ },
  { feature: "push-webhook", methods: ["GET", "PUT", "DELETE"], path: /^\/push-webhook$/ },
  { feature: "mention-actions", methods: ["GET"], path: /^\/mention-actions\/pending$/ },
  { feature: "mention-actions", methods: ["POST"], path: /^\/mention-actions\/execute$/ },
  { feature: "weekly-report-key-points", methods: ["POST"], path: /^\/weekly-report-key-points$/ },
  { feature: "weekly-report-memory", methods: ["POST"], path: /^\/weekly-report-memory$/ },
  { feature: "memory-dispositions", methods: ["POST"], path: /^\/memory-dispositions$/ },
  { feature: "apps", methods: ["GET"], path: /^\/apps$/ },
  { feature: "apps", methods: ["GET"], path: /^\/apps\/marketplace$/ },
  { feature: "reminders", methods: ["POST"], path: /^\/reminders$/ },
  { feature: "context", methods: ["GET"], path: /^\/context$/ },
  { feature: "credentials", methods: ["POST"], path: /^\/credentials\/self\/revoke$/ },
];

export function externalAgentFeature(method: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${API}/`)) return undefined;
  const path = pathname.slice(API.length).replace(/\/+$/, "") || "/";
  return ROUTES.find((route) => route.methods.includes(method) && route.path.test(path))?.feature;
}

export function externalAgentFeatures(): string[] {
  return [...new Set(ROUTES.map((route) => route.feature))].sort();
}
