import type { AppBotScope } from "#src/features/apps/app-bot";

const API = "/api/agent/v1";

/**
 * What a bot key may call on the Agent API, by capability (`APP_BOT_SCOPES`). Anything not listed
 * is refused, so a new Agent API route is closed to bots until it is added here on purpose: the
 * key carries no tasks, knowledge, attachments, reminders, apps, MCP-style tools or channel
 * management, only receiving and answering messages, the people and channels needed to address
 * them, and following up its own mentions.
 */
const ROUTES: readonly { scope: AppBotScope; method: string; path: RegExp }[] = [
  { scope: "send", method: "POST", path: /^\/messages$/ },
  { scope: "read", method: "GET", path: /^\/messages$/ },
  { scope: "read", method: "GET", path: /^\/messages\/search$/ },
  { scope: "read", method: "GET", path: /^\/messages\/[^/%]+\/resolve$/ },
  { scope: "read", method: "GET", path: /^\/events$/ },
  { scope: "mentions", method: "GET", path: /^\/messages\/[^/%]+\/mention-deliveries$/ },
  // Reading one channel it can see, and finding a person to open a direct message with.
  { scope: "channels", method: "GET", path: /^\/channels\/[^/%]+$/ },
  { scope: "channels", method: "GET", path: /^\/users\/[^/%]+$/ },
];

/** The capability that covers the call, or `undefined` when a bot key may not make it. */
export function appBotCapability(method: string, pathname: string): AppBotScope | undefined {
  if (!pathname.startsWith(`${API}/`)) return undefined;
  const path = pathname.slice(API.length).replace(/\/+$/, "") || "/";
  return ROUTES.find((route) => route.method === method && route.path.test(path))?.scope;
}
