import { unlink } from "node:fs/promises";
import type { AppOwnedListResponse, AppRegistrationStatusResponse } from "@lrm/coforge-sdk/agent";
import { toActionCardAction } from "./action-prepare-input";
import type { AppRegistrationClient } from "./app-registration-client";
import type { AppRegistrationInvocation } from "./app-registration-args";
import { CliError } from "./cli-error";
import { createPrivateFile, type NewPrivateFile } from "./private-file";

/** What the register commands need beyond the daemon proxy; tests inject the file and platform. */
export type AppRegistrationIo = {
  stdout(text: string): void;
  platform?: string;
  /** Opens `path` for writing as a new file with mode 0600, failing if it exists. */
  createExclusive?(
    path: string,
  ): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }>;
  remove?(path: string): Promise<void>;
};

function formatStatus(status: AppRegistrationStatusResponse): string {
  const card = status.cardMessageId ? ` (card ${status.cardMessageId})` : "";
  if (status.status === "card_pending")
    return `card_pending${card}: waiting for a Workspace owner or admin to commit it.`;
  if (status.status === "cancelled")
    return `cancelled${card}: the card was dismissed; nothing was registered.`;
  const by = status.committedBy ? ` Committed by ${status.committedBy}.` : "";
  return `committed${card}: the app ${status.clientKey ?? ""} exists and you are its owner Agent.${by} Its client secret was sent to your inbox (coforge inbox check); if you missed it, run coforge app rotate-secret --client ${status.clientKey ?? "<key>"} --output <new file>.`;
}

function formatOwned(list: AppOwnedListResponse): string {
  const lines: string[] = [];
  for (const card of list.pending)
    lines.push(
      `pending card ${card.cardMessageId}: ${card.name}${card.clientKey ? ` (${card.clientKey})` : ""}`,
    );
  for (const app of list.apps)
    lines.push(`${app.clientKey} — ${app.name} (${app.role === "owner" ? "you own it" : "admin"})`);
  return lines.length > 0
    ? lines.join("\n")
    : "You have no pending register cards and own no apps. Run coforge app prepare register to ask for one.";
}

/** Fails with a message that names what to do, before or after the secret exists. */
function failure(
  code: string,
  message: string,
  json: boolean,
  suggestedNextAction?: string,
): CliError {
  return new CliError({
    code,
    message,
    retryable: false,
    suggestedNextAction,
    outputMode: json ? "json" : "text",
  });
}

/**
 * `coforge app prepare register|status|list --owned|rotate-secret`. The client secret is written
 * only to the new file `--output` names and never printed.
 */
export async function runAppRegistrationCommand(
  invocation: AppRegistrationInvocation,
  deps: {
    client: AppRegistrationClient;
    /** `coforge action prepare`'s request: posts the card. */
    prepare(
      target: string,
      action: ReturnType<typeof toActionCardAction>,
    ): Promise<{ messageId?: string }>;
  },
  io: AppRegistrationIo,
): Promise<number> {
  if (invocation.command === "app-prepare-register") {
    const action = toActionCardAction(invocation.action);
    const { messageId } = await deps.prepare(invocation.target, action);
    io.stdout(
      [
        `Posted the register card${messageId ? ` ${messageId}` : ""} in ${invocation.target}. Nothing is registered yet.`,
        "Ask a Workspace owner or admin to commit it (members cannot).",
        `Then run: coforge app status ${messageId ? `--card ${messageId}` : "--client <key>"}`,
        "When it is committed, you become the app's owner Agent and its client secret arrives once in your inbox (coforge inbox check). Store it in a file; never post it in chat. If you miss it, run coforge app rotate-secret --client <key> --output <new file>.",
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (invocation.command === "app-status") {
    const status = await deps.client.status(
      invocation.card ? { card: invocation.card } : { client: invocation.client! },
    );
    io.stdout(`${invocation.json ? JSON.stringify(status) : formatStatus(status)}\n`);
    return 0;
  }
  if (invocation.command === "app-list-owned") {
    const { ok: _ok, ...list } = await deps.client.owned();
    io.stdout(`${invocation.json ? JSON.stringify(list) : formatOwned({ ok: true, ...list })}\n`);
    return 0;
  }
  return rotateSecret(invocation, deps.client, io);
}

async function rotateSecret(
  invocation: Extract<AppRegistrationInvocation, { command: "app-rotate-secret" }>,
  client: AppRegistrationClient,
  io: AppRegistrationIo,
): Promise<number> {
  const { json, output, client: clientKey } = invocation;
  if ((io.platform ?? process.platform) === "win32")
    throw failure(
      "UNSUPPORTED_PLATFORM",
      "rotate-secret is not supported on Windows: it cannot make the secret file private (mode 0600).",
      json,
    );
  let file: NewPrivateFile;
  try {
    file = await (io.createExclusive ?? createPrivateFile)(output);
  } catch (error) {
    const exists = (error as { code?: string }).code === "EEXIST";
    throw failure(
      exists ? "OUTPUT_EXISTS" : "OUTPUT_UNWRITABLE",
      exists
        ? `${output} already exists; the secret is only written to a new file. Nothing was rotated.`
        : `${output} cannot be created (${(error as { code?: string }).code ?? "error"}). Nothing was rotated.`,
      json,
      "Choose a new path in a directory you can write, then run the command again.",
    );
  }
  const remove = io.remove ?? unlink;
  let secret: string;
  try {
    ({ clientSecret: secret } = await client.rotateSecret(clientKey));
  } catch (error) {
    await file.close().catch(() => {});
    await remove(output).catch(() => {});
    throw error;
  }
  try {
    await file.write(`${secret}\n`);
    await file.close();
  } catch {
    throw failure(
      "OUTPUT_WRITE_FAILED",
      `The secret for ${clientKey} was rotated, but writing it to ${output} failed, so it is lost and the previous secret no longer works.`,
      json,
      `Remove the empty file ${output} (rm ${output}), then run coforge app rotate-secret --client ${clientKey} --output <new path> again.`,
    );
  }
  io.stdout(
    `${json ? JSON.stringify({ clientKey, output, rotated: true }) : `Rotated the client secret for ${clientKey}; the previous secret stopped working. The new secret is in ${output} (mode 0600). It is not printed here; read it from that file, and keep it out of chat.`}\n`,
  );
  return 0;
}
