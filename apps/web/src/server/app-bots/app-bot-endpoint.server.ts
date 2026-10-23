import type { AppRateLimits } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { authenticateClient } from "#src/server/authorization-server/client-authentication.server";
import type { GrantStore } from "#src/server/authorization-server/grants.server";
import {
  NO_STORE,
  refuseIfRateLimited,
} from "#src/server/authorization-server/http-headers.server";
import { APP_BOT_STATUS_MAX_UNITS } from "#src/features/apps/app-bot";
import { parseStatusText, type AppBots } from "./app-bots.server";
import type { BotRefusal } from "./app-bot-store";

const STATUS_FOR: Record<BotRefusal, number> = {
  installation_not_found: 404,
  bot_not_granted: 403,
  bot_not_active: 404,
  credential_exists: 409,
};

const DESCRIPTION: Record<BotRefusal, string> = {
  installation_not_found: "no such installation of this app",
  bot_not_granted: "a Workspace owner or admin has not granted the bot to this installation",
  bot_not_active: "the bot is disabled; grant it again to reactivate it",
  credential_exists: "the bot already has a live key; send rotate: true to replace it",
};

const failure = (status: number, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status, headers: NO_STORE });

/** The request's JSON object body; `{}` for an empty one, `undefined` for anything else. */
async function jsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two calls an app's backend makes about its bot, under the installation API family
 * (`POST /api/app-installations/<id>/bot-token`, `PUT .../bot-status`). Both authenticate the app
 * with its client credentials (`client_secret_basic`, RFC 6749 §2.3.1) and nothing else: a user's
 * or Agent's token, or any bearer, is `invalid_client`, because the bot's authority is the
 * Workspace admin's grant and a short-lived delegated token must not become a long-lived key. An
 * installation that is not this app's is `installation_not_found`, as one that does not exist.
 * They are not behind the `app-bot` flag (that gates only the Settings UI).
 */
export class AppBotEndpoint {
  constructor(
    private readonly bots: AppBots,
    private readonly store: Pick<GrantStore, "findClient">,
    private readonly options: {
      issuer: string;
      limits: Pick<AppRateLimits, "token" | "installation">;
    },
  ) {}

  /** `POST {rotate?: boolean}`: the bot's key, shown once. */
  async token(request: Request, installationId: string): Promise<Response> {
    const client = await authenticateClient(request, this.store, this.options.issuer);
    if (client instanceof Response) return client;
    const limited = await refuseIfRateLimited(this.options.limits.token, client.clientId);
    if (limited) return limited;
    const body = await jsonObject(request);
    const rotate = body?.rotate ?? false;
    if (!body || typeof rotate !== "boolean")
      return failure(400, "invalid_request", "rotate must be a boolean");
    const minted = await this.bots.mintKey(client.clientId, installationId, rotate);
    return minted.ok
      ? Response.json(minted.key, { headers: NO_STORE })
      : this.refusal(minted.refusal, 404);
  }

  /** `PUT {text}`: the line shown beside the bot; `null` or no `text` clears it. */
  async status(request: Request, installationId: string): Promise<Response> {
    const client = await authenticateClient(request, this.store, this.options.issuer);
    if (client instanceof Response) return client;
    const limited = await refuseIfRateLimited(
      this.options.limits.installation,
      `${client.clientId}:${installationId}`,
    );
    if (limited) return limited;
    const body = await jsonObject(request);
    const status = body ? parseStatusText(body.text) : "invalid";
    if (status === "invalid")
      return failure(
        400,
        "invalid_request",
        `text must be a non-empty string of at most ${APP_BOT_STATUS_MAX_UNITS} UTF-16 units, or null`,
      );
    const written = await this.bots.setStatus(client.clientId, installationId, status.text);
    return written.ok
      ? Response.json({ text: status.text }, { headers: NO_STORE })
      : this.refusal(written.refusal, 403);
  }

  /** `bot_not_active` is a 404 for the key and a 403 for the status line, as the reference has it. */
  private refusal(refusal: BotRefusal, notActive: 403 | 404): Response {
    const status = refusal === "bot_not_active" ? notActive : STATUS_FOR[refusal];
    return failure(status, refusal, DESCRIPTION[refusal]);
  }
}
