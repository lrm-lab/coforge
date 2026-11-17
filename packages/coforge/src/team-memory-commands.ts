import {
  decodeTeamMemoryCommand,
  type TeamMemoryCommand,
  type TeamMemoryResult,
} from "@lrm/coforge-sdk/agent";
export type TeamMemoryInvocation = {
  command: "memory";
  scope: "team";
  request: TeamMemoryCommand;
  json: boolean;
};
export function parseTeamMemoryArgs(args: readonly string[]): TeamMemoryInvocation {
  const row: Record<string, unknown> = { operation: args[0] };
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--archived") {
      row.archived = true;
      continue;
    }
    if (!flag.startsWith("--") || args[index + 1] === undefined)
      throw new Error("Team memory flags require values; see coforge manual get memory");
    const key = flag.slice(2);
    if (key in row) throw new Error(`repeated flag: ${flag}`);
    const value = args[++index]!;
    row[key] = ["offset", "revision", "fromRevision"].includes(key)
      ? Number(value)
      : key === "sources"
        ? JSON.parse(value)
        : key === "pinned"
          ? value === "true"
            ? true
            : value === "false"
              ? false
              : value
          : key === "projectId" && value === "none"
            ? null
            : value;
  }
  if (["prepare", "create", "update", "merge"].includes(String(row.operation))) {
    row.kind ??= "fact";
    row.applicability ??= "";
  }
  if (row.operation === "project-create") row.description ??= "";
  return { command: "memory", scope: "team", request: decodeTeamMemoryCommand(row), json };
}
export async function runTeamMemoryCommand(
  invocation: TeamMemoryInvocation,
  transport: { teamMemory?(request: TeamMemoryCommand): Promise<TeamMemoryResult> },
): Promise<string> {
  if (!transport.teamMemory) throw new Error("Team memory requires an updated Computer");
  const result = await transport.teamMemory(invocation.request);
  if (invocation.json) return JSON.stringify(result);
  return [
    ...result.entries.map(
      (entry) =>
        `${entry.title} [${entry.id}]\n${entry.content}\nSource: ${entry.source}\nApplies to: ${entry.applicability || "unspecified"}\nRevision: ${entry.revision}\nState: ${entry.status}\nAuthor: ${entry.authorAgentId ?? entry.authorUserId}${entry.change ? `\nChanged by: ${entry.change.actorAgentId ?? entry.change.actorUserId} (${entry.change.operation})\nReason: ${entry.change.reason}\nMerged from: ${JSON.stringify(entry.change.mergedFrom)}` : ""}`,
    ),
    ...(result.maintenanceHint
      ? [
          `After completing the person's task, run coforge memory maintenance --scope team for this Project. Inspect full evidence for at most 5 entries within 2 minutes. Preserve sources and important decisions; stop for new work. Never delete, unpin, or merge different scopes. See coforge manual get memory.`,
        ]
      : []),
    ...(result.maintenance
      ? [
          `Maintenance batch: ${result.maintenance.remaining} entry changes remaining; expires at ${result.maintenance.expiresAt}. Read full candidates before editing. Use --maintenanceToken ${result.maintenance.token} on every update, merge or archive, together with the normal reviewToken. This budget cannot permanently delete, touch protected memory or move Projects.`,
        ]
      : []),
    ...(result.projects ?? []).map(
      (project) => `${project.name} [${project.id}] (${project.slug})\n${project.description}`,
    ),
    ...(invocation.request.operation === "history"
      ? result.entries.map(
          (entry) =>
            `Full version: coforge memory get --scope team --id ${entry.id} --revision ${entry.revision}`,
        )
      : []),
    ...(result.status === "review_required"
      ? [
          `Inspect related entries and get their full evidence. If this operation is appropriate, resubmit unchanged with --reviewToken ${result.reviewToken}. Otherwise choose another operation and review again.`,
        ]
      : []),
    ...(result.nextOffset === undefined ? [] : [`Continue with --offset ${result.nextOffset}.`]),
    ...(result.status === "deleted"
      ? ["Team memory deleted; its content and history were removed."]
      : []),
    ...(!result.entries.length && result.status === "ok" ? ["No matching team memory."] : []),
  ].join("\n\n");
}
