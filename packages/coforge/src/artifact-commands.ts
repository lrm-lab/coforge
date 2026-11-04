import { writeFile } from "node:fs/promises";
import { agentApiRoutes, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { CliError, withOutputMode } from "#src/cli-error";
import { invalidArgument } from "#src/command-help/index";
import { readProxyErrorBody, requireProxySetup } from "#src/proxy-request";
import {
  formatArtifactCreated,
  formatArtifactHistory,
  formatArtifactList,
  formatArtifactRead,
  formatArtifactSave,
  type ArtifactSaveAnswer,
} from "#src/artifact-format";

/**
 * `coforge artifact create|list|read|push|history|revert` (task #385): the Agent's documents. A
 * document's text comes from `--file <path>`, or stdin with `--file -`; the server applies the
 * web page's rules and merges a save with what others saved since its base.
 */
export type ArtifactInvocation = {
  command: "artifact";
  request: ArtifactRequestDraft;
  /** `--file`: where the text comes from (`-` is stdin). */
  file?: string;
  /** `read --output`: where the text goes, instead of stdout. */
  output?: string;
  json?: boolean;
};

/** A request before its text is read and its idempotency key made. */
type ArtifactRequestDraft =
  | Omit<Extract<AgentArtifactRequest, { operation: "push" }>, "idempotencyKey" | "text">
  | Omit<Extract<AgentArtifactRequest, { operation: "revert" }>, "idempotencyKey">
  | Omit<Extract<AgentArtifactRequest, { operation: "create" }>, "text">
  | Extract<AgentArtifactRequest, { operation: "list" | "read" | "history" }>;

export type ArtifactTransport = {
  artifact?(request: AgentArtifactRequest): Promise<unknown>;
};

const OPERATIONS = ["create", "list", "read", "push", "history", "revert"] as const;
type Operation = (typeof OPERATIONS)[number];

/** Each operation's flags: `text` ones take a string, `count` ones a whole number. */
const FLAGS: Record<Operation, { text: string[]; count: string[]; positional: boolean }> = {
  create: { text: ["--title", "--target", "--file"], count: [], positional: false },
  list: { text: ["--target"], count: [], positional: false },
  read: { text: ["--output"], count: ["--version"], positional: true },
  push: {
    text: ["--file", "--title", "--description", "--note", "--label"],
    count: ["--base"],
    positional: true,
  },
  history: { text: [], count: ["--before", "--limit"], positional: true },
  revert: { text: [], count: ["--to", "--base"], positional: true },
};

export function parseArtifactArgs(args: readonly string[]): ArtifactInvocation {
  const operation = args[0] as Operation;
  if (!OPERATIONS.includes(operation))
    throw invalidArgument("artifact", `Unknown artifact command ${args[0] ?? "(none)"}`);
  const command = `artifact ${operation}`;
  const flags = FLAGS[operation];
  const text: Record<string, string> = {};
  const count: Record<string, number> = {};
  let artifact: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--") && flags.positional && artifact === undefined) {
      artifact = arg;
      continue;
    }
    const value = args[index + 1];
    const known = flags.text.includes(arg) || flags.count.includes(arg);
    if (!known) throw invalidArgument(command, `Unexpected argument ${arg}`);
    if (value === undefined) throw invalidArgument(command, `${arg} needs a value`);
    if (arg in text || arg in count) throw invalidArgument(command, `${arg} is given twice`);
    if (flags.count.includes(arg)) {
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw invalidArgument(command, `${arg} takes a version number, not "${value}"`);
      count[arg] = Number(value);
    } else text[arg] = value;
    index += 1;
  }
  if (flags.positional && !artifact)
    throw invalidArgument(command, "Name the document: its id, as create printed it");
  const need = (flag: string) => {
    if (count[flag] === undefined) throw invalidArgument(command, `${flag} is required`);
    return count[flag]!;
  };
  const optional = <T>(key: string, value: T | undefined) =>
    value === undefined ? {} : { [key]: value };
  const options = { ...optional("file", text["--file"]), ...(json ? { json: true } : {}) };
  switch (operation) {
    case "create": {
      const title = text["--title"]?.trim();
      if (!title) throw invalidArgument(command, "--title is required");
      return {
        command: "artifact",
        request: { operation, title, ...optional("target", text["--target"]) },
        ...options,
      };
    }
    case "list":
      return {
        command: "artifact",
        request: { operation, ...optional("target", text["--target"]) },
        ...options,
      };
    case "read":
      return {
        command: "artifact",
        request: { operation, artifact: artifact!, ...optional("version", count["--version"]) },
        ...optional("output", text["--output"]),
        ...options,
      };
    case "push": {
      const request = {
        operation,
        artifact: artifact!,
        baseVersion: need("--base"),
        ...optional("title", text["--title"]),
        ...optional("description", text["--description"]),
        ...optional("note", text["--note"]),
        ...optional("label", text["--label"]),
      };
      if (Object.keys(request).length === 3 && text["--file"] === undefined)
        throw invalidArgument(command, "Nothing to save: give --file, or a setting to change");
      return { command: "artifact", request, ...options };
    }
    case "history":
      return {
        command: "artifact",
        request: {
          operation,
          artifact: artifact!,
          ...optional("before", count["--before"]),
          ...optional("limit", count["--limit"]),
        },
        ...options,
      };
    case "revert":
      return {
        command: "artifact",
        request: { operation, artifact: artifact!, to: need("--to"), baseVersion: need("--base") },
        ...options,
      };
  }
}

/** Reads the text, sends the operation, and says what came of it. */
export async function runArtifact(
  invocation: ArtifactInvocation,
  transport: ArtifactTransport,
  readText: (file: string) => Promise<string> = readArtifactText,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  const draft = invocation.request;
  const text = invocation.file === undefined ? undefined : await readText(invocation.file);
  const request = {
    ...draft,
    ...(text === undefined ? {} : { text }),
    ...(draft.operation === "push" || draft.operation === "revert"
      ? { idempotencyKey: crypto.randomUUID() }
      : {}),
  } as AgentArtifactRequest;
  const json = invocation.json === true;
  const result = await transport.artifact(request).catch((error: unknown) => {
    throw error instanceof CliError ? withOutputMode(error, json ? "json" : "text") : error;
  });
  switch (request.operation) {
    case "create":
      return json ? result : formatArtifactCreated(result as never);
    case "list":
      return json ? result : formatArtifactList(result as never);
    case "read": {
      const read = result as Parameters<typeof formatArtifactRead>[0];
      if (invocation.output !== undefined) await writeFile(invocation.output, read.text);
      if (json) return result;
      return formatArtifactRead(read, invocation.output === undefined);
    }
    case "history":
      return json ? result : formatArtifactHistory(request.artifact, result as never);
    case "push":
    case "revert": {
      const answer = result as ArtifactSaveAnswer;
      const base = request.baseVersion;
      if (answer.status === "conflict" || answer.status === "missing") {
        const formatted = formatArtifactSave(request.artifact, base, answer);
        throw new CliError({
          code: answer.status === "conflict" ? "ARTIFACT_CONFLICT" : "ARTIFACT_MISSING",
          message: formatted.message,
          retryable: answer.status === "missing",
          suggestedNextAction: formatted.next,
          ...(json ? { details: answer, outputMode: "json" } : { stdoutText: formatted.stdout }),
        });
      }
      return json ? result : formatArtifactSave(request.artifact, base, answer).message;
    }
  }
}

async function readArtifactText(file: string): Promise<string> {
  if (file === "-") return new Response(Bun.stdin.stream()).text();
  try {
    return await Bun.file(file).text();
  } catch {
    throw new CliError({
      code: "INVALID_ARG",
      message: `Cannot read ${file}`,
      retryable: false,
    });
  }
}

/** What the CLI says when the Workspace has not switched documents on. */
export const ARTIFACTS_DISABLED_MESSAGE =
  "这个工作区没有开启文档（请工作区 owner/admin 在 设置 → 实验功能 里打开）。This Workspace has not enabled documents: a Workspace owner or admin switches them on in Settings > Experiments.";

/** `POST /api/agent/v1/artifacts` through the daemon's proxy, as the Agent. */
export async function artifactRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentArtifactRequest,
): Promise<unknown> {
  requireProxySetup("artifact", context, proxyUrl);
  const route = agentApiRoutes.proxy.artifacts;
  // Create, push and revert change something, and none of them is replayed when run again: one
  // that failed on the way may still have landed. Read, list and history only read.
  const writes =
    request.operation !== "read" && request.operation !== "list" && request.operation !== "history";
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path), {
      method: route.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      // A save merges up to three 2 MiB documents under the server's 15-second lock.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CliError({
      code: "ARTIFACT_FAILED",
      message: "agent artifact request failed (network or timeout)",
      retryable: !writes,
      ...(writes ? { suggestedNextAction: mayHaveLanded(request) } : {}),
    });
  }
  if (response.ok) return response.json();
  const { json } = await readProxyErrorBody(response);
  const message = json?.error ?? `HTTP ${response.status}`;
  if (message.includes("(artifacts-disabled)"))
    throw new CliError({
      code: "ARTIFACTS_DISABLED",
      message: ARTIFACTS_DISABLED_MESSAGE,
      retryable: false,
    });
  const next =
    json?.code === "NOT_FOUND"
      ? "The document or conversation does not exist, or you cannot read it."
      : message.includes("(artifact-base-moved)") && "artifact" in request
        ? `The document has a newer version than --base: read it (coforge artifact read ${request.artifact}) and use the version it prints.`
        : writes && response.status >= 500
          ? mayHaveLanded(request)
          : json?.suggested_next_action;
  throw new CliError({
    code: json?.code ?? "ARTIFACT_FAILED",
    message: `artifact ${request.operation} failed: ${message}`,
    // A read is safe to run again; a missing `retryable` leaves it to the failure, as the
    // proxy's contract says: a 5xx is worth another try.
    retryable: !writes && (json?.retryable ?? response.status >= 500),
    ...(next ? { suggestedNextAction: next } : {}),
    ...(json?.proxy?.correlation_id ? { correlationId: json.proxy.correlation_id } : {}),
  });
}

function mayHaveLanded(request: AgentArtifactRequest): string {
  return "artifact" in request
    ? `The change may have landed: read the document (coforge artifact read ${request.artifact}) before trying again.`
    : "The document may have been made, and creating it again makes a second one: check the conversation's documents on the web page first.";
}
