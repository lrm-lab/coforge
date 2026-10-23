import { APP_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
import {
  APP_SHARE_LINK_MAX_DAYS,
  APP_SHARE_LINK_MIN_DAYS,
  type AppRecoverOwnerAction,
  type AppUpdateChanges,
} from "@lrm/coforge-sdk/agent";
import { readOptions, type Invalid } from "./app-registration-args";

/** The default life of a share link, as the app editor makes it. */
export const DEFAULT_SHARE_LINK_DAYS = 30;

type WithClient = { client: string; json: boolean };
export type AppManagementInvocation =
  | ({ command: "app-update"; changes: AppUpdateChanges } & WithClient)
  | ({ command: "app-logo"; file: string } & WithClient)
  | ({ command: "app-clear-logo" } & WithClient)
  | ({ command: "app-transfer-owner"; toAgent: string } & WithClient)
  | { command: "app-prepare-recover-owner"; target: string; action: AppRecoverOwnerAction }
  | ({ command: "app-delete" } & WithClient)
  | ({ command: "app-share-link"; expiresDays: number } & WithClient)
  | ({ command: "app-share-link-status" } & WithClient)
  | ({ command: "app-revoke-share-link" } & WithClient)
  | ({ command: "app-request-publish" } & WithClient)
  | ({ command: "app-request-unpublish" } & WithClient);

const SIMPLE: Record<string, AppManagementInvocation["command"]> = {
  "clear-logo": "app-clear-logo",
  delete: "app-delete",
  "share-link-status": "app-share-link-status",
  "revoke-share-link": "app-revoke-share-link",
  "request-publish": "app-request-publish",
  "request-unpublish": "app-request-unpublish",
};

/** The subcommands (after `app`) this module parses; `prepare recover-owner` is given as
 * `prepare-recover-owner`. */
export const APP_MANAGEMENT_SUBCOMMANDS = [
  "update",
  "logo",
  "transfer-owner",
  "share-link",
  "prepare-recover-owner",
  ...Object.keys(SIMPLE),
];

export function isAppManagementInvocation(invocation: {
  command: string;
}): invocation is AppManagementInvocation {
  return [
    "app-update",
    "app-logo",
    "app-transfer-owner",
    "app-prepare-recover-owner",
    "app-share-link",
    ...Object.values(SIMPLE),
  ].includes(invocation.command);
}

/** `coforge app update|logo|clear-logo|transfer-owner|prepare recover-owner|delete|share-link|
 * share-link-status|revoke-share-link|request-publish|request-unpublish ...`, without `app`. */
export function parseAppManagementArgs(
  subcommand: string,
  rest: readonly string[],
  invalid: Invalid,
): AppManagementInvocation {
  const spec = (values: string[], extra: { repeatable?: string[]; bare?: string[] } = {}) =>
    readOptions(
      rest,
      { values, repeatable: extra.repeatable, bare: ["--json", ...(extra.bare ?? [])] },
      invalid,
    );
  const needClient = (options: { one(option: string): string | undefined }) => {
    const client = options.one("--client");
    if (!client) invalid("--client is required: the app's client key");
    return client;
  };
  if (subcommand === "prepare-recover-owner") {
    const options = readOptions(
      rest,
      { values: ["--client", "--to-agent", "--target", "--draft-hint"] },
      invalid,
    );
    const [clientKey, toAgent, target] = [
      needClient(options),
      options.one("--to-agent"),
      options.one("--target"),
    ];
    if (!toAgent) invalid("--to-agent is required: the Agent that becomes the owner Agent");
    if (!target) invalid("--target is required: the channel or person to post the card to");
    const draftHint = options.one("--draft-hint");
    return {
      command: "app-prepare-recover-owner",
      target,
      action: {
        type: "app:recover_owner",
        clientKey,
        toAgent,
        ...(draftHint === undefined ? {} : { draftHint }),
      },
    };
  }
  if (subcommand === "update") {
    const options = spec(
      [
        "--client",
        "--name",
        "--description",
        "--when-to-use",
        "--category",
        "--homepage-url",
        "--redirect-url",
        "--add-redirect-url",
        "--agent-manifest-url",
        "--scope",
      ],
      {
        repeatable: ["--redirect-url", "--add-redirect-url", "--scope"],
        bare: ["--clear-scopes", "--clear-homepage-url", "--clear-agent-manifest-url"],
      },
    );
    const client = needClient(options);
    const changes: AppUpdateChanges = {};
    const set = (field: "name" | "description" | "whenToUse" | "category", flag: string) => {
      const value = options.one(flag);
      if (value !== undefined) changes[field] = value;
    };
    set("name", "--name");
    set("description", "--description");
    set("whenToUse", "--when-to-use");
    set("category", "--category");
    for (const [field, flag, clear] of [
      ["homepageUrl", "--homepage-url", "--clear-homepage-url"],
      ["agentManifestUrl", "--agent-manifest-url", "--clear-agent-manifest-url"],
    ] as const) {
      if (options.one(flag) !== undefined && options.has(clear))
        invalid(`${flag} and ${clear} cannot be combined`);
      if (options.has(clear)) changes[field] = null;
      else if (options.one(flag) !== undefined) changes[field] = options.one(flag);
    }
    const [redirects, added] = [options.all("--redirect-url"), options.all("--add-redirect-url")];
    if (redirects.length > 0 && added.length > 0)
      invalid("--redirect-url (replace) and --add-redirect-url (add) cannot be combined");
    if (redirects.length > 0) changes.redirectUrls = redirects;
    if (added.length > 0) changes.addRedirectUrls = added;
    const scopes = options.all("--scope");
    for (const scope of scopes)
      if (!(APP_SCOPES as readonly string[]).includes(scope))
        invalid(`--scope takes one of ${APP_SCOPES.join(", ")}, not "${scope}"`);
    if (scopes.length > 0 && options.has("--clear-scopes"))
      invalid("--scope and --clear-scopes cannot be combined");
    if (scopes.length > 0) changes.scopes = scopes;
    if (options.has("--clear-scopes")) changes.scopes = [];
    if (Object.keys(changes).length === 0) invalid("Name at least one field to change");
    return { command: "app-update", client, changes, json: options.has("--json") };
  }
  if (subcommand === "logo") {
    const options = spec(["--client", "--file"]);
    const file = options.one("--file");
    if (!file) invalid("--file is required: a PNG, JPEG, GIF or WebP of at most 5 MB");
    return { command: "app-logo", client: needClient(options), file, json: options.has("--json") };
  }
  if (subcommand === "transfer-owner") {
    const options = spec(["--client", "--to-agent"]);
    const toAgent = options.one("--to-agent");
    if (!toAgent) invalid("--to-agent is required: the Agent that becomes the owner Agent");
    return {
      command: "app-transfer-owner",
      client: needClient(options),
      toAgent,
      json: options.has("--json"),
    };
  }
  if (subcommand === "share-link") {
    const options = spec(["--client", "--expires-days"]);
    const raw = options.one("--expires-days") ?? String(DEFAULT_SHARE_LINK_DAYS);
    const days = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
    if (days < APP_SHARE_LINK_MIN_DAYS || days > APP_SHARE_LINK_MAX_DAYS)
      invalid(
        `--expires-days takes a whole number from ${APP_SHARE_LINK_MIN_DAYS} to ${APP_SHARE_LINK_MAX_DAYS}, not "${raw}"`,
      );
    return {
      command: "app-share-link",
      client: needClient(options),
      expiresDays: days,
      json: options.has("--json"),
    };
  }
  const command = SIMPLE[subcommand];
  if (!command) return invalid(`Unknown app command ${subcommand}`);
  const options = spec(["--client"]);
  return { command, client: needClient(options), json: options.has("--json") } as never;
}
