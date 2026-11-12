import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { invalidArgument } from "#src/command-help/index";
import { optional, parseFlags, type FlagSpec } from "#src/artifact-flags";

/**
 * `coforge artifact pull|push|download`: an artifact as a directory of files. A pull writes every
 * file of a version and a state file; a push sends the files whose sha256 differs from that state,
 * as a new version over the pulled one; a directory with no state creates a new artifact.
 */
export type ArtifactDirectoryDraft =
  | { operation: "pull"; artifact: string; dir?: string; rev?: number }
  | {
      operation: "push";
      dir: string;
      target?: string;
      title?: string;
      description?: string;
      entry?: string;
      note?: string;
      label?: string;
      delete?: string[];
      includeHidden?: boolean;
    }
  | { operation: "download"; artifact: string; path: string; output?: string; rev?: number };

export type ArtifactDirectoryInvocation = {
  command: "artifact";
  directory: ArtifactDirectoryDraft;
  json?: boolean;
};

/** What the directory commands need from the daemon's proxy. */
export type ArtifactDirectoryTransport = {
  artifact?(request: AgentArtifactRequest): Promise<unknown>;
  artifactUpload?(sha256: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  artifactDownload?(request: {
    artifact: string;
    path: string;
    version?: number;
  }): Promise<Uint8Array>;
};

const DIRECTORY_FLAGS: Record<"pull" | "push" | "download", FlagSpec> = {
  pull: { text: ["--dir"], count: ["--rev"], positionals: 1 },
  download: { text: ["--output"], count: ["--rev"], positionals: 2 },
  push: {
    text: ["--target", "--title", "--description", "--entry", "--note", "--label"],
    bool: ["--include-hidden"],
    repeat: ["--delete"],
    positionals: 1,
  },
};

export function parseDirectoryArgs(args: readonly string[]): ArtifactDirectoryInvocation {
  const operation = args[0] as "pull" | "push" | "download";
  const command = `artifact ${operation}`;
  const { positionals, text, count, repeated, switches, json } = parseFlags(
    command,
    args.slice(1),
    DIRECTORY_FLAGS[operation],
  );
  const want = operation === "download" ? 2 : 1;
  if (operation !== "push" && positionals.length < want)
    throw invalidArgument(
      command,
      operation === "download"
        ? "Name the artifact and the file: coforge artifact download <id> <path>"
        : operation === "pull"
          ? "Name the artifact: its id, as create printed it"
          : "Name one directory",
    );
  const extra = json ? { json: true as const } : {};
  switch (operation) {
    case "pull":
      return {
        command: "artifact",
        directory: {
          operation,
          artifact: positionals[0]!,
          ...optional("dir", text["--dir"]),
          ...optional("rev", count["--rev"]),
        },
        ...extra,
      };
    case "download":
      return {
        command: "artifact",
        directory: {
          operation,
          artifact: positionals[0]!,
          path: positionals[1]!,
          ...optional("output", text["--output"]),
          ...optional("rev", count["--rev"]),
        },
        ...extra,
      };
    case "push":
      return {
        command: "artifact",
        directory: {
          operation,
          dir: positionals[0] ?? ".",
          ...optional("target", text["--target"]),
          ...optional("title", text["--title"]),
          ...optional("description", text["--description"]),
          ...optional("entry", text["--entry"]),
          ...optional("note", text["--note"]),
          ...optional("label", text["--label"]),
          ...(repeated.length > 0 ? { delete: repeated } : {}),
          ...(switches.has("--include-hidden") ? { includeHidden: true } : {}),
        },
        ...extra,
      };
  }
}
