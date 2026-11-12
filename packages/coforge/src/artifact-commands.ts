import { writeFile } from "node:fs/promises";
import {
  agentApiRoutes,
  artifactOperationTraits,
  type AgentArtifactRequest,
} from "@lrm/coforge-sdk/agent";
import { shellWord } from "#src/artifact-directory";
import { artifactNetworkFailure, artifactRefusal, type ArtifactCall } from "#src/artifact-failure";
import { CliError, withOutputMode } from "#src/cli-error";
import { invalidArgument } from "#src/command-help/index";
import { optional, parseFlags, type FlagSpec } from "#src/artifact-flags";
import { requireProxySetup } from "#src/proxy-request";
import {
  parseDirectoryArgs,
  type ArtifactDirectoryInvocation,
  type ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { runArtifactDirectory } from "#src/artifact-directory-commands";
import {
  COMMENT_OPERATIONS,
  isCommentOperation,
  parseCommentArgs,
  type ArtifactCommentInvocation,
  type CommentOperation,
} from "#src/artifact-comment-args";
import { runArtifactComment } from "#src/artifact-comment-commands";
import {
  formatArtifactCreated,
  formatArtifactHistory,
  formatArtifactList,
  formatArtifactRead,
  formatArtifactSave,
  type ArtifactReadAnswer,
  type ArtifactSaveAnswer,
} from "#src/artifact-format";

/**
 * `coforge artifact create|list|read|push|history|revert` (task #385): the Agent's artifacts, and
 * web pages (`create --kind html`, task #490). The text (an artifact's Markdown, a page's HTML)
 * comes from `--file <path>`, or stdin with `--file -`; the server applies the web page's rules
 * and merges an artifact's save with what others saved since its base.
 */
export type ArtifactInvocation =
  | ArtifactRequestInvocation
  | ArtifactDirectoryInvocation
  | ArtifactCommentInvocation;

export type ArtifactRequestInvocation = {
  command: "artifact";
  request: ArtifactRequestDraft;
  /** `read --files`: list every file of the version, not the first few. */
  allFiles?: boolean;
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
  | Omit<Extract<AgentArtifactRequest, { operation: "create" }>, "text" | "idempotencyKey">
  | Extract<AgentArtifactRequest, { operation: "list" | "read" | "history" | "share" }>;

export type ArtifactTransport = ArtifactDirectoryTransport;

/** Artifacts on one `list` page unless `--limit` says otherwise. */
const ARTIFACT_LIST_PAGE = 20;

const OPERATIONS = [
  "create",
  "list",
  "read",
  "push",
  "history",
  "revert",
  "share",
  "pull",
  "download",
  ...COMMENT_OPERATIONS,
] as const;
type Operation = (typeof OPERATIONS)[number];

/** Each operation's flags. */
const FLAGS: Record<Exclude<Operation, "pull" | "download" | CommentOperation>, FlagSpec> = {
  create: {
    text: ["--title", "--target", "--file", "--kind", "--description"],
    positionals: 0,
  },
  list: { text: ["--target", "--query", "--after"], count: ["--limit"], positionals: 0 },
  read: { text: ["--output"], count: ["--version"], bool: ["--files"], positionals: 1 },
  push: {
    text: ["--file", "--title", "--description", "--note", "--label"],
    count: ["--base"],
    positionals: 1,
  },
  history: { count: ["--before", "--limit"], positionals: 1 },
  revert: { count: ["--to", "--base"], positionals: 1 },
  share: { text: ["--to", "--target", "--note"], positionals: 1 },
};

export function parseArtifactArgs(args: readonly string[]): ArtifactInvocation {
  const operation = args[0] as Operation;
  if (!OPERATIONS.includes(operation))
    throw invalidArgument("artifact", `Unknown artifact command ${args[0] ?? "(none)"}`);
  if (operation === "share") return parseShareArgs(args);
  if (operation === "pull" || operation === "download") return parseDirectoryArgs(args);
  if (isCommentOperation(operation)) return parseCommentArgs(operation, args.slice(1));
  // `push <id> --base <n> --file <path>` saves one text file over an artifact; without either flag
  // the argument is a directory of files.
  if (operation === "push" && !args.includes("--base") && !args.includes("--file"))
    return parseDirectoryArgs(args);
  const command = `artifact ${operation}`;
  const flags = FLAGS[operation];
  const {
    positionals: [artifact],
    text,
    count,
    switches,
    json,
  } = parseFlags(command, args.slice(1), flags);
  if (flags.positionals && !artifact)
    throw invalidArgument(command, "Name the artifact: its id, as create printed it");
  const need = (flag: string) => {
    if (count[flag] === undefined) throw invalidArgument(command, `${flag} is required`);
    return count[flag]!;
  };
  const options = { ...optional("file", text["--file"]), ...(json ? { json: true } : {}) };
  switch (operation) {
    case "create": {
      const title = text["--title"]?.trim();
      if (!title) throw invalidArgument(command, "--title is required");
      const kind = text["--kind"];
      if (kind !== undefined && kind !== "markdown" && kind !== "html")
        throw invalidArgument(
          command,
          `--kind is markdown (Markdown text) or html (a web page), not "${kind}"`,
        );
      const description = text["--description"]?.trim();
      // A web page says what it is on its card: the line people read before opening it.
      if (kind === "html" && !description)
        throw invalidArgument(
          command,
          "--kind html needs --description: one line saying what the page shows",
        );
      return {
        command: "artifact",
        request: {
          operation,
          title,
          ...optional("target", text["--target"]),
          ...optional("kind", kind),
          ...optional("description", description),
        },
        ...options,
      };
    }
    case "list":
      return {
        command: "artifact",
        request: {
          operation,
          ...optional("target", text["--target"]),
          ...optional("query", text["--query"]),
          ...optional("after", text["--after"]),
          // Always a page: the server answers `nextCursor` only to a paged request.
          limit: count["--limit"] ?? ARTIFACT_LIST_PAGE,
        },
        ...options,
      };
    case "read":
      return {
        command: "artifact",
        request: { operation, artifact: artifact!, ...optional("version", count["--version"]) },
        ...optional("output", text["--output"]),
        ...(switches.has("--files") ? { allFiles: true } : {}),
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

function parseShareArgs(args: readonly string[]): ArtifactRequestInvocation {
  const command = "artifact share";
  const artifactIds: string[] = [];
  const targets: string[] = [];
  let note: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      artifactIds.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw invalidArgument(command, `${arg} needs a value`);
    if (arg === "--to" || arg === "--target") targets.push(value);
    else if (arg === "--note") {
      if (note !== undefined) throw invalidArgument(command, "--note is given twice");
      note = value;
    } else throw invalidArgument(command, `Unexpected argument ${arg}`);
    index += 1;
  }
  if (artifactIds.length === 0)
    throw invalidArgument(command, "Name at least one artifact: its id");
  if (targets.length === 0) throw invalidArgument(command, "--to is required at least once");
  return {
    command: "artifact",
    request: {
      operation: "share",
      artifactIds,
      targets,
      ...(note === undefined ? {} : { note }),
      requestId: crypto.randomUUID(),
    },
    ...(json ? { json: true } : {}),
  };
}

/** Reads the text, sends the operation, and says what came of it. */
export async function runArtifact(
  invocation: ArtifactInvocation,
  transport: ArtifactTransport,
  readText: (file: string) => Promise<string> = readArtifactText,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  if ("directory" in invocation) return runArtifactDirectory(invocation, transport);
  if ("comment" in invocation) return runArtifactComment(invocation, transport, readText);
  const draft = invocation.request;
  const text = invocation.file === undefined ? undefined : await readText(invocation.file);
  const request = {
    ...draft,
    ...(text === undefined ? {} : { text }),
    // create, push and revert each carry a key, so a retry after a lost response does not make a
    // second artifact or version.
    ...(draft.operation === "create" || draft.operation === "push" || draft.operation === "revert"
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
    case "list": {
      if (json) return result;
      const more = (cursor: string) =>
        [
          "coforge artifact list",
          ...(request.target === undefined ? [] : [`--target ${shellWord(request.target)}`]),
          ...(request.query === undefined ? [] : [`--query ${shellWord(request.query)}`]),
          `--after ${cursor}`,
          `--limit ${request.limit}`,
        ].join(" ");
      return formatArtifactList(result as never, more);
    }
    case "read": {
      const read = result as ArtifactReadAnswer;
      if (invocation.output !== undefined) await writeFile(invocation.output, read.text);
      if (json) return result;
      return formatArtifactRead(
        read,
        invocation.output === undefined,
        invocation.allFiles === true,
      );
    }
    case "history":
      return json ? result : formatArtifactHistory(request.artifact, result as never);
    case "push":
    case "revert": {
      const answer = result as ArtifactSaveAnswer;
      const base = request.baseVersion;
      if (answer.status === "missing") {
        const formatted = formatArtifactSave(base, answer);
        throw new CliError({
          code: "ARTIFACT_MISSING",
          message: formatted.message,
          retryable: true,
          suggestedNextAction: formatted.next,
          ...(json ? { details: answer, outputMode: "json" } : {}),
        });
      }
      return json ? result : formatArtifactSave(base, answer).message;
    }
    case "share":
      return json ? result : formatArtifactShare(result as ArtifactShareAnswer);
  }
}

type ArtifactShareAnswer = {
  outcome: string;
  results: readonly {
    target: string;
    status: "success" | "failed";
    error?: { code: string };
  }[];
};

function formatArtifactShare(answer: ArtifactShareAnswer): string {
  return answer.results
    .map((result) =>
      result.status === "success"
        ? `Shared artifact with ${result.target}.`
        : `Could not share artifact with ${result.target}: ${result.error?.code ?? "failed"}.`,
    )
    .join("\n");
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

/** `POST /api/agent/v1/artifacts` through the daemon's proxy, as the Agent. */
export async function artifactRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentArtifactRequest,
): Promise<unknown> {
  requireProxySetup("artifact", context, proxyUrl);
  const route = agentApiRoutes.proxy.artifacts;
  // Anything but a read changes something, and none of it is replayed when run again: one that
  // failed on the way may still have landed.
  const traits = artifactOperationTraits(request.operation);
  const writes = !traits.readOnly;
  const call: ArtifactCall = {
    label: `artifact ${request.operation}`,
    writes,
    ...(writes ? { mayHaveLanded: mayHaveLanded(request) } : {}),
    ...("artifact" in request
      ? {
          baseMoved: `The artifact has a newer version than --base: read it (coforge artifact read ${request.artifact}) and use the version it prints.`,
          // Others commented on what this changes or answers since the Agent last read comments.
          ...(traits.gatedByComments
            ? { unseenComments: `Read them first: coforge artifact comments ${request.artifact}` }
            : {}),
        }
      : {}),
  };
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path), {
      method: route.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      // A save merges up to three 2 MiB artifacts under the server's 15-second lock.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw artifactNetworkFailure("agent artifact request failed (network or timeout)", call);
  }
  if (response.ok) return response.json();
  throw await artifactRefusal(response, call);
}

function mayHaveLanded(request: AgentArtifactRequest): string {
  if ("artifactIds" in request)
    return "The artifact share may have landed: read the target conversation before trying again.";
  if (!("artifact" in request))
    return "The artifact may have been made, and creating it again makes a second one: check the conversation's artifacts on the web page first.";
  return artifactOperationTraits(request.operation).commentWrite
    ? `The comment may have landed: read the comments (coforge artifact comments ${request.artifact} --all) before trying again.`
    : `The change may have landed: read the artifact (coforge artifact read ${request.artifact}) before trying again.`;
}
