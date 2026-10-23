import type { AppBotSummary } from "#src/features/apps/app-bot";

/** One installed app's bot as Settings reads it: whether the app declares one, and where this
 * Workspace's installation stands. */
export type AppBotView = AppBotSummary & { declared: boolean };

/** What the Agent API knows of a bot once its key checks out: who it speaks as. `userId` is the
 * person who first granted it (the Agent's creator). */
export type AppBotPrincipal = { agentId: string; workspaceId: string; userId: string };

export type GrantOutcome =
  | { kind: "granted"; bot: AppBotSummary }
  | { kind: "no_installation" }
  | { kind: "not_declared" }
  | { kind: "handle_conflict" };

/** Why the app's backend was refused. The first three are the same for the status line. */
export type BotRefusal =
  | "installation_not_found"
  | "bot_not_granted"
  | "bot_not_active"
  | "credential_exists";

export type MintedKey = { credentialId: string; agentId: string };

/** The rows of an app's bots. Who may grant, and what the app's backend is told, stay in
 * `server/app-bots/`; every change locks its installation row so grants, revokes, keys and
 * status lines of one installation run one at a time. */
export interface AppBotStore {
  /** The person's role in the Workspace; `undefined` for a non-member. */
  memberRole(workspaceId: string, userId: string): Promise<string | undefined>;
  /** The app `key` that `workspaceId` owns. */
  findOwnApp(workspaceId: string, key: string): Promise<{ id: string } | undefined>;
  /** Sets `enableBot`; turning it off revokes every grant of the app and disables the bots, in
   * the same transaction. */
  declare(appId: string, enabled: boolean, input: { userId: string; at: Date }): Promise<void>;
  grant(input: {
    workspaceId: string;
    appKey: string;
    userId: string;
    at: Date;
  }): Promise<GrantOutcome>;
  /** Revokes the grant of the app `appKey` in the Workspace; nothing when there is none. */
  revoke(input: { workspaceId: string; appKey: string; userId: string; at: Date }): Promise<void>;
  /** By app key, for each app installed in the Workspace. */
  workspaceBots(workspaceId: string): Promise<Map<string, AppBotView>>;
  /** Mints the key whose SHA-256 is `keyHash` for the installation of the app `clientKey`; with
   * `rotate` every live key is revoked in the same transaction, otherwise a live key refuses. */
  mintKey(input: {
    clientKey: string;
    installationId: string;
    rotate: boolean;
    keyHash: string;
  }): Promise<({ ok: true } & MintedKey) | { ok: false; refusal: BotRefusal }>;
  /** Writes the status line (`null` clears it) only while the bot is granted and active. */
  setStatus(input: {
    clientKey: string;
    installationId: string;
    text: string | null;
  }): Promise<{ ok: true } | { ok: false; refusal: Exclude<BotRefusal, "credential_exists"> }>;
  /** The bot whose live key has this hash, while its grant, generation, Agent and app still hold. */
  findByKeyHash(keyHash: string): Promise<AppBotPrincipal | undefined>;
}
