import type { AgentLabel, AgentLabelListResponse } from "@lrm/coforge-sdk/agent";

export type LabelInvocation = { command: "label-list"; json?: boolean };

const LABEL_USAGE = "Usage: coforge label list [--json]";

/** `label list [--json]`. */
export function parseLabelArgs(args: readonly string[]): LabelInvocation {
  if (args[0] !== "list") throw new Error(LABEL_USAGE);
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--json") json = true;
    else throw new Error(LABEL_USAGE);
  }
  return { command: "label-list", ...(json ? { json: true } : {}) };
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

/** The transport call `label list` makes. */
export type LabelTransport = {
  labelList?(): Promise<AgentLabelListResponse>;
};

/** Runs `label list` and returns what it prints. */
export async function runLabelCommand(
  transport: LabelTransport,
  invocation: LabelInvocation,
): Promise<AgentLabelListResponse | string> {
  if (!transport.labelList) throw new Error("Label transport is unavailable");
  const result = await transport.labelList();
  return invocation.json ? result : formatLabelList(result);
}
