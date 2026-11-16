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
} from "#src/artifact-comment-args";
import { runArtifactComment } from "#src/artifact-comment-commands";
import {
  formatArtifactDeleted,
  formatArtifactList,
  formatArtifactMoved,
  formatArtifactRead,
  type ArtifactDeletedAnswer,
  type ArtifactMovedAnswer,
  type ArtifactReadAnswer,
} from "#src/artifact-format";
import { formatFollow, type FollowAnswer } from "#src/artifact-follow-format";

/**
 * `coforge artifact list|read|pull|push|download|move|delete|comments|comment|review|resolve|reopen|follow|unfollow`
 * (task #385): an Agent's artifacts. An artifact is a versioned set of files; an Agent changes one only
 * by `pull` and `push` of a directory (`artifact-directory-commands.ts`), and the server merges a
 * push over an older version with what others pushed since, by file.
 */
export type ArtifactInvocation =
  | ArtifactRequestInvocation
  | ArtifactDirectoryInvocation
  | ArtifactCommentInvocation;

export type ArtifactRequestInvocation = {
  command: "artifact";
  request: Extract<
    AgentArtifactRequest,
    { operation: "list" | "read" | "move" | "delete" | "follow" | "unfollow" }
  >;
  /** `read --files`: list every file of the version, not the first few. */
  allFiles?: boolean;
  /** `read --output`: where the entry file's text goes, instead of stdout. */
  output?: string;
  json?: boolean;
};

export type ArtifactTransport = ArtifactDirectoryTransport;

/** Artifacts on one `list` page unless `--limit` says otherwise. */
const ARTIFACT_LIST_PAGE = 20;

const OPERATIONS = [
  "list",
  "read",
  "push",
  "pull",
  "download",
  "move",
  "delete",
  ...COMMENT_OPERATIONS,
  "follow",
  "unfollow",
] as const;
type Operation = (typeof OPERATIONS)[number];
type RequestOperation = "list" | "read" | "move" | "delete" | "follow" | "unfollow";

/** Each request operation's flags. */
const FLAGS: Record<RequestOperation, FlagSpec> = {
  list: { text: ["--target", "--query", "--after"], count: ["--limit"], positionals: 0 },
  read: { text: ["--output"], count: ["--version"], bool: ["--files"], positionals: 1 },
  move: { text: ["--to"], positionals: 1 },
  delete: { positionals: 1 },
  follow: { positionals: 1 },
  unfollow: { positionals: 1 },
};

const LINK_SHARING_TARGETS = ["public", "anyone-with-link"];

function moveTarget(command: string, value: string | undefined): string {
  if (value === undefined) throw invalidArgument(command, "Say where it moves: --to workspace");
  if (LINK_SHARING_TARGETS.includes(value))
    throw new CliError({
      code: "FORBIDDEN",
      message:
        "Only a person can turn on link sharing: an Agent cannot move an artifact to anyone with the link. Nothing was changed. A person does it from the artifact's page (Who can see > Anyone with the link).",
      retryable: false,
    });
  if (value !== "workspace") throw invalidArgument(command, `--to takes workspace, not "${value}"`);
  return value;
}

export function parseArtifactArgs(args: readonly string[]): ArtifactInvocation {
  const operation = args[0] as Operation;
  if (!OPERATIONS.includes(operation))
    throw invalidArgument("artifact", `Unknown artifact command ${args[0] ?? "(none)"}`);
  if (operation === "pull" || operation === "push" || operation === "download")
    return parseDirectoryArgs(args);
  if (isCommentOperation(operation)) return parseCommentArgs(operation, args.slice(1));
  const command = `artifact ${operation}`;
  const flags = FLAGS[operation as RequestOperation];
  const {
    positionals: [artifact],
    text,
    count,
    switches,
    json,
  } = parseFlags(command, args.slice(1), flags);
  if (flags.positionals && !artifact)
    throw invalidArgument(command, "Name the artifact: its id, as push printed it");
  const options = json ? { json: true as const } : {};
  switch (operation as RequestOperation) {
    case "follow":
    case "unfollow":
      return {
        command: "artifact",
        request: { operation: operation as "follow" | "unfollow", artifact: artifact! },
        ...options,
      };
    case "list":
      return {
        command: "artifact",
        request: {
          operation: "list",
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
        request: {
          operation: "read",
          artifact: artifact!,
          ...optional("version", count["--version"]),
        },
        ...optional("output", text["--output"]),
        ...(switches.has("--files") ? { allFiles: true } : {}),
        ...options,
      };
    case "move":
      return {
        command: "artifact",
        request: { operation: "move", artifact: artifact!, to: moveTarget(command, text["--to"]) },
        ...options,
      };
    case "delete":
      return {
        command: "artifact",
        request: { operation: "delete", artifact: artifact! },
        ...options,
      };
  }
}

/** Sends the operation and says what came of it. A comment's words come from stdin. */
export async function runArtifact(
  invocation: ArtifactInvocation,
  transport: ArtifactTransport,
  readStdin: () => Promise<string> = readStdinText,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  if ("directory" in invocation) return runArtifactDirectory(invocation, transport);
  if ("comment" in invocation) return runArtifactComment(invocation, transport, readStdin);
  const request = invocation.request;
  const json = invocation.json === true;
  const result = await transport.artifact(request).catch((error: unknown) => {
    throw error instanceof CliError ? withOutputMode(error, json ? "json" : "text") : error;
  });
  switch (request.operation) {
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
    case "follow":
    case "unfollow":
      return json ? result : formatFollow(result as FollowAnswer);
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
    case "move":
      return json ? result : formatArtifactMoved(result as ArtifactMovedAnswer);
    case "delete":
      return json ? result : formatArtifactDeleted(result as ArtifactDeletedAnswer);
  }
}

const readStdinText = () => new Response(Bun.stdin.stream()).text();

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
  const artifact = artifactOf(request);
  const call: ArtifactCall = {
    label: `artifact ${request.operation}`,
    writes,
    ...(writes ? { mayHaveLanded: mayHaveLanded(request) } : {}),
    // Others commented on what this changes or answers since the Agent last read comments.
    ...(artifact !== undefined && traits.gatedByComments
      ? { unseenComments: `Read them first: coforge artifact comments ${artifact}` }
      : {}),
  };
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path), {
      method: route.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      // A push may wait behind others' pushes of the artifact, under the server's row lock.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw artifactNetworkFailure("agent artifact request failed (network or timeout)", call);
  }
  if (response.ok) return response.json();
  throw await artifactRefusal(response, call);
}

/** The artifact a request names; a push that makes one names none. */
const artifactOf = (request: AgentArtifactRequest) =>
  "artifact" in request ? request.artifact : undefined;

function mayHaveLanded(request: AgentArtifactRequest): string {
  const artifact = artifactOf(request);
  if (artifact === undefined)
    return "The artifact may have been made, and pushing the directory again makes a second one: check the home's artifacts first (coforge artifact list).";
  return artifactOperationTraits(request.operation).commentWrite
    ? `The comment may have landed: read the comments (coforge artifact comments ${artifact} --all) before trying again.`
    : `The change may have landed: read the artifact (coforge artifact read ${artifact}) before trying again.`;
}
