import { writeFile } from "node:fs/promises";
import {
  artifactOperationTraits,
  createAgentApiClient,
  type AgentArtifactRequest,
} from "@lrm/coforge-sdk/agent";
import { shellWord } from "#src/artifact-directory";
import type { ArtifactCall } from "#src/artifact-failure";
import { CliError, withOutputMode } from "#src/cli-error";
import { invalidArgument } from "#src/command-help/index";
import { optional, parseFlags, type FlagSpec } from "#src/artifact-flags";
import { createArtifactProxyAgentApiTransport } from "#src/sdk-proxy-transport";
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
  parseCheckArgs,
  runArtifactCheck,
  type ArtifactCheckInvocation,
} from "#src/artifact-check-commands";
import {
  formatArtifactDeleted,
  formatArtifactList,
  formatArtifactMoved,
  formatArtifactRead,
  formatArtifactSaved,
  type ArtifactDeletedAnswer,
  type ArtifactMovedAnswer,
  type ArtifactReadAnswer,
  type ArtifactSavedAnswer,
} from "#src/artifact-format";
import { formatFollow, type FollowAnswer } from "#src/artifact-follow-format";

export type ArtifactInvocation =
  | ArtifactRequestInvocation
  | ArtifactDirectoryInvocation
  | ArtifactCommentInvocation
  | ArtifactCheckInvocation;

export type ArtifactRequestInvocation = {
  command: "artifact";
  request: Extract<
    AgentArtifactRequest,
    { operation: "list" | "read" | "move" | "delete" | "follow" | "unfollow" | "save" }
  >;
  allFiles?: boolean;
  output?: string;
  json?: boolean;
};

export type ArtifactTransport = ArtifactDirectoryTransport;

const ARTIFACT_LIST_PAGE = 20;

const OPERATIONS = [
  "list",
  "read",
  "push",
  "pull",
  "download",
  "check",
  "move",
  "delete",
  "save",
  ...COMMENT_OPERATIONS,
  "follow",
  "unfollow",
] as const;
type Operation = (typeof OPERATIONS)[number];
type RequestOperation = "list" | "read" | "move" | "delete" | "follow" | "unfollow" | "save";

const FLAGS: Record<RequestOperation, FlagSpec> = {
  list: { text: ["--target", "--query", "--after"], count: ["--limit"], positionals: 0 },
  read: { text: ["--output"], count: ["--version", "--rev"], bool: ["--files"], positionals: 1 },
  move: { text: ["--to"], positionals: 1 },
  delete: { positionals: 1 },
  save: { positionals: 1 },
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
  if (operation === "check") return parseCheckArgs(args.slice(1));
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
    throw invalidArgument(
      command,
      operation === "save"
        ? "Name the attachment: its id, as message read printed it"
        : "Name the artifact: its id, as push printed it",
    );
  const options = json ? { json: true as const } : {};
  switch (operation as RequestOperation) {
    case "save":
      return {
        command: "artifact",
        request: { operation: "save", attachment: artifact! },
        ...options,
      };
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
    case "read": {
      const rev = count["--rev"];
      const version = count["--version"];
      if (rev !== undefined && version !== undefined && rev !== version)
        throw invalidArgument(command, "Pass either --rev or --version, not both");
      return {
        command: "artifact",
        request: {
          operation: "read",
          artifact: artifact!,
          ...optional("version", rev ?? version),
        },
        ...optional("output", text["--output"]),
        ...(switches.has("--files") ? { allFiles: true } : {}),
        ...options,
      };
    }
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

export async function runArtifact(
  invocation: ArtifactInvocation,
  transport: ArtifactTransport,
  readStdin?: () => Promise<string>,
  stdinIsTTY = readStdin === undefined ? Boolean(process.stdin.isTTY) : false,
): Promise<unknown> {
  if (!transport.artifact) throw new Error("Artifact transport is unavailable");
  if ("directory" in invocation) return runArtifactDirectory(invocation, transport);
  if ("check" in invocation) return runArtifactCheck(invocation, transport);
  if ("comment" in invocation)
    return runArtifactComment(invocation, transport, readStdin ?? readStdinText, stdinIsTTY);
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
    case "save":
      return json ? result : formatArtifactSaved(result as ArtifactSavedAnswer);
    case "move":
      return json ? result : formatArtifactMoved(result as ArtifactMovedAnswer);
    case "delete":
      return json ? result : formatArtifactDeleted(result as ArtifactDeletedAnswer);
  }
}

const readStdinText = () => new Response(Bun.stdin.stream()).text();

export async function artifactRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentArtifactRequest,
): Promise<unknown> {
  const traits = artifactOperationTraits(request.operation);
  const writes = !traits.repeatable;
  const artifact = artifactOf(request);
  const call: ArtifactCall = {
    label: `artifact ${request.operation}`,
    writes,
    ...(writes ? { mayHaveLanded: mayHaveLanded(request) } : {}),
    ...(artifact !== undefined && traits.gatedByComments ? { unseenArtifact: artifact } : {}),
  };
  const client = createAgentApiClient(
    createArtifactProxyAgentApiTransport(proxyEndpoint, context, proxyUrl, call),
  );
  return client.artifacts.execute(request);
}

const artifactOf = (request: AgentArtifactRequest) =>
  "artifact" in request ? request.artifact : undefined;

function mayHaveLanded(request: AgentArtifactRequest): string {
  const artifact = artifactOf(request);
  if (request.operation === "save")
    return "The artifact may have been made: run the same save again, it answers the artifact it already made.";
  if (artifact === undefined)
    return "The artifact may have been made, and pushing the directory again makes a second one: check the home's artifacts first (coforge artifact list).";
  return artifactOperationTraits(request.operation).commentWrite
    ? `The comment may have landed: read the comments (coforge artifact comments ${artifact} --all) before trying again.`
    : `The change may have landed: read the artifact (coforge artifact read ${artifact}) before trying again.`;
}
