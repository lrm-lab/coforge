import { APP_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
import type { AppRegisterAction } from "@lrm/coforge-sdk/agent";
import { cliFlagBadToken, parseCliFlags, type CliFlagOptions } from "./cli-flags";

export type AppRegistrationInvocation =
  | { command: "app-prepare-register"; target: string; action: AppRegisterAction }
  | { command: "app-status"; card?: string; client?: string; json: boolean }
  | { command: "app-list-owned"; json: boolean }
  | { command: "app-rotate-secret"; client: string; output: string; json: boolean };

export function isAppRegistrationInvocation(invocation: {
  command: string;
}): invocation is AppRegistrationInvocation {
  return ["app-prepare-register", "app-status", "app-list-owned", "app-rotate-secret"].includes(
    invocation.command,
  );
}

export type Invalid = (message: string) => never;

const stripFlagPrefix = (flag: string) => (flag.startsWith("--") ? flag.slice(2) : flag);

export function readOptions(
  args: readonly string[],
  spec: { values: readonly string[]; repeatable?: readonly string[]; bare?: readonly string[] },
  invalid: Invalid,
) {
  const options: CliFlagOptions = {};
  for (const flag of spec.bare ?? []) options[stripFlagPrefix(flag)] = { type: "boolean" };
  for (const flag of spec.values)
    options[stripFlagPrefix(flag)] = {
      type: "string",
      multiple: spec.repeatable?.includes(flag) === true,
    };

  const { values } = parseCliFlags({
    args,
    options,
    allowEmptyValues: false,
    duplicates: "error-strings",
    onError(error) {
      if (error.kind === "missing-value") invalid(`${error.flag} needs a value`);
      if (error.kind === "duplicate") invalid(`${error.flag} is given twice`);
      invalid(`Unexpected argument ${cliFlagBadToken(error)}`);
    },
  });

  return {
    one: (option: string) => {
      const value = values[stripFlagPrefix(option)];
      return Array.isArray(value)
        ? (value[0] as string | undefined)
        : (value as string | undefined);
    },
    all: (option: string) => {
      const value = values[stripFlagPrefix(option)];
      if (Array.isArray(value)) return value as string[];
      return typeof value === "string" ? [value] : [];
    },
    has: (option: string) => values[stripFlagPrefix(option)] === true,
  };
}

/** `coforge app prepare|status|rotate-secret ...`, without the leading `app`. */
export function parseAppRegistrationArgs(
  subcommand: string,
  rest: readonly string[],
  invalid: Invalid,
): AppRegistrationInvocation {
  if (subcommand === "prepare") {
    const [what, ...flags] = rest;
    if (what !== "register") invalid(`Unknown prepare command ${what ?? ""}`.trim());
    const options = readOptions(
      flags,
      {
        values: [
          "--target",
          "--name",
          "--redirect-url",
          "--client-key",
          "--homepage-url",
          "--description",
          "--when-to-use",
          "--category",
          "--agent-manifest-url",
          "--scope",
          "--draft-hint",
        ],
        repeatable: ["--redirect-url", "--scope"],
      },
      invalid,
    );
    const target = options.one("--target");
    const name = options.one("--name");
    if (!target) invalid("--target is required: the channel or person to post the card to");
    if (!name) invalid("--name is required");
    const scopes = options.all("--scope");
    for (const scope of scopes)
      if (!(APP_SCOPES as readonly string[]).includes(scope))
        invalid(`--scope takes one of ${APP_SCOPES.join(", ")}, not "${scope}"`);
    const optional = (key: keyof AppRegisterAction, flag: string) => {
      const value = options.one(flag);
      return value === undefined ? {} : { [key]: value };
    };
    return {
      command: "app-prepare-register",
      target,
      action: {
        type: "app:register",
        name,
        redirectUrls: options.all("--redirect-url"),
        scopes,
        ...optional("clientKey", "--client-key"),
        ...optional("homepageUrl", "--homepage-url"),
        ...optional("description", "--description"),
        ...optional("whenToUse", "--when-to-use"),
        ...optional("category", "--category"),
        ...optional("agentManifestUrl", "--agent-manifest-url"),
        ...optional("draftHint", "--draft-hint"),
      },
    };
  }
  if (subcommand === "status") {
    const options = readOptions(
      rest,
      { values: ["--card", "--client"], bare: ["--json"] },
      invalid,
    );
    const [card, client] = [options.one("--card"), options.one("--client")];
    if (!card === !client) invalid("Give exactly one of --card and --client");
    return {
      command: "app-status",
      ...(card ? { card } : { client }),
      json: options.has("--json"),
    };
  }
  if (subcommand === "rotate-secret") {
    const options = readOptions(
      rest,
      { values: ["--client", "--output"], bare: ["--json"] },
      invalid,
    );
    const [client, output] = [options.one("--client"), options.one("--output")];
    if (!client) invalid("--client is required");
    if (!output) invalid("--output is required: the new file the secret is written to");
    return { command: "app-rotate-secret", client, output, json: options.has("--json") };
  }
  return invalid(`Unknown app command ${subcommand}`);
}
