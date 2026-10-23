/** What an app's bot is, for code the browser shares with the server (`server/app-bots/`). */

/** What the bot's key may do on the Agent API, in the order a key lists them. */
export const APP_BOT_SCOPES = ["send", "read", "mentions", "channels"] as const;
export type AppBotScope = (typeof APP_BOT_SCOPES)[number];

/** The longest status line an app publishes beside its bot, in UTF-16 code units (JavaScript
 * string length) counted before trimming. */
export const APP_BOT_STATUS_MAX_UNITS = 160;

/** An ordinary Agent or a member already holds the app's key as a handle: the grant is refused. */
export const APP_BOT_HANDLE_CONFLICT = "app-bot-handle-conflict";
/** The app does not declare a bot (`enableBot` is off): there is nothing to grant. */
export const APP_BOT_NOT_DECLARED = "app-bot-not-declared";

/** Where one installation's bot stands, as Settings shows it. */
export type AppBotSummary = {
  installationId: string;
  /** The Workspace's owner or admin granted the bot and it is active. */
  granted: boolean;
  /** The line the app published beside the bot, while it is granted. */
  statusText: string | null;
};
