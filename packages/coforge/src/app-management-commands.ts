import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { APP_LOGO_MAX_BYTES, type AppManagedSummary } from "@lrm/coforge-sdk/agent";
import { toActionCardAction } from "./action-prepare-input";
import type { AppManagementClient } from "./app-management-client";
import type { AppManagementInvocation } from "./app-management-args";
import { CliError } from "./cli-error";

/** What these commands need beyond the daemon proxy. */
export type AppManagementIo = {
  stdout(text: string): void;
};

const LOGO_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function usage(message: string, json: boolean): CliError {
  return new CliError({
    code: "INVALID_ARGUMENT",
    message,
    retryable: false,
    outputMode: json ? "json" : "text",
  });
}

function formatApp(app: AppManagedSummary): string {
  return [
    `${app.clientKey} — ${app.name} (${app.publishStatus})`,
    `  Category: ${app.category}`,
    `  Homepage: ${app.homepageUrl ?? "none"}`,
    `  Redirect URLs: ${app.redirectUrls.join(", ") || "none"}`,
    `  Agent manifest: ${app.agentManifestUrl ?? "none"}`,
    `  Scopes: ${app.scopes.join(", ")}`,
    `  Logo: ${app.hasLogo ? "set" : "none"}`,
  ].join("\n");
}

/**
 * The management commands of an owner or admin-role Agent (`app-management.ts` in the SDK). A
 * plain-text answer says what happened; `--json` prints the server's answer without its `ok`. The
 * share link's URL is printed once, here, and never stored.
 */
export async function runAppManagementCommand(
  invocation: AppManagementInvocation,
  deps: {
    client: AppManagementClient;
    /** `coforge action prepare`'s request: posts the card. */
    prepare(
      target: string,
      action: ReturnType<typeof toActionCardAction>,
    ): Promise<{ messageId?: string }>;
  },
  io: AppManagementIo,
): Promise<number> {
  const print = (json: boolean, value: { ok?: boolean }, text: string) => {
    const { ok: _ok, ...rest } = value;
    io.stdout(`${json ? JSON.stringify(rest) : text}\n`);
    return 0;
  };
  const { client } = deps;
  switch (invocation.command) {
    case "app-prepare-recover-owner": {
      const { messageId } = await deps.prepare(
        invocation.target,
        toActionCardAction(invocation.action),
      );
      io.stdout(
        [
          `Posted the recover-owner card${messageId ? ` ${messageId}` : ""} in ${invocation.target}. Nothing changed yet.`,
          "Ask a Workspace owner or admin to commit it (members cannot). It only works while the app has no live owner Agent.",
        ].join("\n") + "\n",
      );
      return 0;
    }
    case "app-update": {
      const answer = await client.call("update", {
        clientKey: invocation.client,
        changes: invocation.changes,
      });
      return print(invocation.json, answer, `Updated.\n${formatApp(answer.app)}`);
    }
    case "app-logo": {
      const type = LOGO_TYPES[extname(invocation.file).toLowerCase()];
      if (!type)
        throw usage("--file must be a .png, .jpg, .jpeg, .gif or .webp image", invocation.json);
      const size = (await stat(invocation.file)).size;
      if (size === 0 || size > APP_LOGO_MAX_BYTES)
        throw usage("The logo must be between 1 byte and 5 MB", invocation.json);
      const bytes = await Bun.file(invocation.file).bytes();
      const answer = await client.call("logo_set", {
        clientKey: invocation.client,
        contentType: type,
        dataBase64: Buffer.from(bytes).toString("base64"),
      });
      return print(invocation.json, answer, `Logo set.\n${formatApp(answer.app)}`);
    }
    case "app-clear-logo": {
      const answer = await client.call("logo_clear", { clientKey: invocation.client });
      return print(invocation.json, answer, `Logo cleared.\n${formatApp(answer.app)}`);
    }
    case "app-transfer-owner": {
      const answer = await client.call("transfer_owner", {
        clientKey: invocation.client,
        toAgent: invocation.toAgent,
      });
      const text = answer.changed
        ? `Transferred ${answer.clientKey} to ${answer.ownerAgent} (was ${answer.previousOwnerAgent ?? "no owner Agent"}) at ${answer.at}.`
        : `${answer.ownerAgent} already owns ${answer.clientKey}; nothing changed.`;
      return print(invocation.json, answer, text);
    }
    case "app-delete": {
      const answer = await client.call("delete", { clientKey: invocation.client });
      return print(invocation.json, answer, `Deleted ${answer.clientKey}.`);
    }
    case "app-share-link": {
      const answer = await client.call("share_link_create", {
        clientKey: invocation.client,
        expiresDays: invocation.expiresDays,
      });
      return print(
        invocation.json,
        answer,
        `Share link for ${answer.clientKey} (expires ${answer.expiresAt}; any earlier link stopped working):\n${answer.url}\nThis is the only time the URL is shown. Give it to the person who installs the app.`,
      );
    }
    case "app-share-link-status": {
      const answer = await client.call("share_link_status", { clientKey: invocation.client });
      return print(
        invocation.json,
        answer,
        answer.active
          ? `${answer.clientKey} has an active share link, made ${answer.createdAt}, expiring ${answer.expiresAt}. The URL is not shown again; run app share-link to make a new one.`
          : `${answer.clientKey} has no active share link.`,
      );
    }
    case "app-revoke-share-link": {
      const answer = await client.call("share_link_revoke", { clientKey: invocation.client });
      return print(
        invocation.json,
        answer,
        `Revoked the share link of ${answer.clientKey}. Workspaces that installed the app keep it.`,
      );
    }
    case "app-request-publish":
    case "app-request-unpublish": {
      const publish = invocation.command === "app-request-publish";
      const answer = await client.call(publish ? "request_publish" : "request_unpublish", {
        clientKey: invocation.client,
      });
      return print(
        invocation.json,
        answer,
        `${answer.clientKey} is now ${answer.publishStatus}: a platform reviewer decides ${publish ? "its publication" : "its removal"}.`,
      );
    }
  }
}
