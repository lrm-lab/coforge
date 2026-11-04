import type {
  AgentLabel,
  AgentLabelListResponse,
  AgentLabelWriteRequest,
  AgentLabelWriteResponse,
} from "@lrm/coforge-sdk/agent";

/** `label list` carries no request; every write carries the one label write it sends. */
export type LabelInvocation = {
  command: "label";
  request?: AgentLabelWriteRequest;
  json?: boolean;
};

const LABEL_USAGE =
  "Usage: coforge label list [--json] | coforge label create <name> --description <text> [--color <color>] [--json] | coforge label rename <name> --to <new name> [--json] | coforge label update <name> --color <color> [--json] | coforge label delete|restore <name> [--json]";

/** Each write subcommand's flags; every one but `list` names its label first. */
const WRITE_FLAGS: Record<string, readonly string[]> = {
  create: ["--description", "--color"],
  rename: ["--to"],
  update: ["--color"],
  delete: [],
  restore: [],
};

/** `label list|create|rename|update|delete|restore`. */
export function parseLabelArgs(args: readonly string[]): LabelInvocation {
  const [subcommand, ...rest] = args;
  const json = rest.includes("--json");
  const options = json ? { json: true } : {};
  const remaining = rest.filter((arg) => arg !== "--json");
  if (subcommand === "list") {
    if (remaining.length) throw new Error(LABEL_USAGE);
    return { command: "label", ...options };
  }
  const flags = subcommand === undefined ? undefined : WRITE_FLAGS[subcommand];
  const [name, ...pairs] = remaining;
  if (!flags || !name?.trim() || name.startsWith("--") || pairs.length % 2)
    throw new Error(LABEL_USAGE);
  const values: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const flag = pairs[index]!;
    const value = pairs[index + 1]!;
    if (!flags.includes(flag) || flag in values || !value.trim()) throw new Error(LABEL_USAGE);
    values[flag] = value;
  }
  const request = writeRequest(subcommand!, name, values);
  if (!request) throw new Error(LABEL_USAGE);
  return { command: "label", request, ...options };
}

function writeRequest(
  subcommand: string,
  label: string,
  values: Record<string, string>,
): AgentLabelWriteRequest | undefined {
  const color = values["--color"];
  switch (subcommand) {
    case "create": {
      const description = values["--description"];
      if (!description) return undefined;
      return { operation: "create", name: label, description, ...(color ? { color } : {}) };
    }
    case "rename":
      return values["--to"] ? { operation: "update", label, name: values["--to"] } : undefined;
    case "update":
      return color ? { operation: "update", label, color } : undefined;
    case "delete":
      return { operation: "update", label, archived: true };
    case "restore":
      return { operation: "update", label, archived: false };
  }
  return undefined;
}

function formatLabel(label: AgentLabel): string {
  const facts = [`color=${label.color}`, `open=${label.openCount}`, `tasks=${label.taskCount}`];
  if (label.group) facts.push(`group=${label.group.name}`);
  if (label.lastUsedAt) facts.push(`lastUsedAt=${label.lastUsedAt}`);
  if (label.archivedAt) facts.push("archived");
  const description = label.description ? ` — ${label.description}` : "";
  return `- ${label.name} (${facts.join(", ")})${description}`;
}

function formatLabelList({ labels }: AgentLabelListResponse): string {
  if (labels.length === 0) return "No labels.";
  return [`Labels (${labels.length}):`, ...labels.map(formatLabel)].join("\n");
}

/** What a write did, in the words of the subcommand that asked for it. */
function formatLabelWrite(request: AgentLabelWriteRequest, { label }: AgentLabelWriteResponse) {
  if (request.operation === "create") {
    const description = label.description ? ` — ${label.description}` : "";
    return `Label ${label.name} (color=${label.color})${description}`;
  }
  if (request.name !== undefined) return `Renamed ${request.label} to ${label.name}.`;
  if (request.color !== undefined) return `Label ${label.name} is now ${label.color}.`;
  if (request.archived)
    return `Deleted ${label.name} (archived): tasks no longer show it and it cannot be attached; \`coforge label restore ${label.name}\` brings it back.`;
  return `Restored ${label.name}.`;
}

/** The transport calls the `label` commands make. */
export type LabelTransport = {
  labelList?(): Promise<AgentLabelListResponse>;
  labelWrite?(request: AgentLabelWriteRequest): Promise<AgentLabelWriteResponse>;
};

/** Runs a `label` command and returns what it prints. */
export async function runLabelCommand(
  transport: LabelTransport,
  invocation: LabelInvocation,
): Promise<AgentLabelListResponse | AgentLabelWriteResponse | string> {
  if (invocation.request) {
    if (!transport.labelWrite) throw new Error("Label transport is unavailable");
    const result = await transport.labelWrite(invocation.request);
    return invocation.json ? result : formatLabelWrite(invocation.request, result);
  }
  if (!transport.labelList) throw new Error("Label transport is unavailable");
  const result = await transport.labelList();
  return invocation.json ? result : formatLabelList(result);
}
