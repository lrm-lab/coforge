import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { invalidArgument } from "#src/command-help/index";

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

type FlagSpec = { text: string[]; count: string[]; bool: string[]; repeat: string[] };

export function parseDirectoryArgs(args: readonly string[]): ArtifactDirectoryInvocation {
  const operation = args[0] as "pull" | "push" | "download";
  const command = `artifact ${operation}`;
  const spec: FlagSpec =
    operation === "pull"
      ? { text: ["--dir"], count: ["--rev"], bool: [], repeat: [] }
      : operation === "download"
        ? { text: ["--output"], count: ["--rev"], bool: [], repeat: [] }
        : {
            text: ["--target", "--title", "--description", "--entry", "--note", "--label"],
            count: [],
            bool: ["--include-hidden"],
            repeat: ["--delete"],
          };
  const positionals: string[] = [];
  const text: Record<string, string> = {};
  const count: Record<string, number> = {};
  const repeated: string[] = [];
  let includeHidden = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (spec.bool.includes(arg)) includeHidden = true;
    else if (!arg.startsWith("--")) positionals.push(arg);
    else {
      const known = [...spec.text, ...spec.count, ...spec.repeat].includes(arg);
      if (!known) throw invalidArgument(command, `Unexpected argument ${arg}`);
      const value = args[index + 1];
      if (value === undefined) throw invalidArgument(command, `${arg} needs a value`);
      index += 1;
      if (spec.repeat.includes(arg)) repeated.push(value);
      else if (arg in text || arg in count) throw invalidArgument(command, `${arg} is given twice`);
      else if (spec.count.includes(arg)) {
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw invalidArgument(command, `${arg} takes a version number, not "${value}"`);
        count[arg] = Number(value);
      } else text[arg] = value;
    }
  }
  const optional = <T>(key: string, value: T | undefined) =>
    value === undefined ? {} : { [key]: value };
  const want = operation === "push" ? 1 : operation === "download" ? 2 : 1;
  if (positionals.length > want || (operation !== "push" && positionals.length < want))
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
          ...(includeHidden ? { includeHidden: true } : {}),
        },
        ...extra,
      };
  }
}
