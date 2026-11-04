import type {
  AgentLabelRecord,
  AgentLabelWriteRequest,
  AgentLabelWriteResponse,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { announceLabelChanged } from "./label-signal.server";
import { LABEL_SELECT, Labels, labelNameKey, type LabelRow } from "./labels.server";

/** What one Agent label write needs: the label store, a lookup by name, and the page signal. */
export type AgentLabelWriteServices = {
  labels: Pick<Labels, "create" | "update">;
  findByName(workspaceId: string, name: string): Promise<LabelRow | null>;
  announce(workspaceId: string, label: LabelRow): Promise<void>;
};

export function productionAgentLabelWrites(db: PrismaClient): AgentLabelWriteServices {
  return {
    labels: new Labels(db),
    findByName: (workspaceId, name) =>
      db.label.findUnique({
        where: { workspaceId_nameKey: { workspaceId, nameKey: labelNameKey(name) } },
        select: LABEL_SELECT,
      }),
    announce: (workspaceId, label) =>
      announceLabelChanged(createCentrifugoServerApi(), workspaceId, { label }),
  };
}

/**
 * `coforge label create|rename|update|delete|restore` (task #508), as the Agent: the same
 * `Labels.create`/`update` the web page calls, so the rules are the page's. `delete` archives (the
 * label leaves every Task and can be restored); the page's permanent delete stays on the page.
 */
export async function runAgentLabelWrite(
  services: AgentLabelWriteServices,
  principal: { workspaceId: string; agentId: string },
  request: AgentLabelWriteRequest,
): Promise<AgentLabelWriteResponse> {
  const { workspaceId, agentId } = principal;
  let label: LabelRow;
  if (request.operation === "create") {
    if (!request.description.trim())
      throw new AppError("INVALID_INPUT", {
        errorId: "label-description",
        hint: "an Agent says what a new label is for: --description",
      });
    label = await services.labels.create(
      workspaceId,
      { agentId },
      {
        name: request.name,
        description: request.description,
        ...(request.color === undefined ? {} : { color: request.color }),
      },
    );
  } else {
    const found = await services.findByName(workspaceId, request.label);
    if (!found)
      throw new AppError("NOT_FOUND", {
        errorId: "task-label-unknown",
        hint: `no label named "${request.label}" in this Workspace; see \`coforge label list\``,
      });
    const { label: _name, operation: _operation, ...changes } = request;
    label = await services.labels.update(workspaceId, { agentId }, found.id, changes);
  }
  // The write has landed; a page that misses the signal catches up on its next load.
  await services.announce(workspaceId, label).catch(() => undefined);
  return { ok: true, label: labelRecord(label) };
}

const labelRecord = (label: LabelRow): AgentLabelRecord => ({
  id: label.id,
  name: label.name,
  color: label.color,
  description: label.description,
  groupId: label.groupId,
  archivedAt: label.archivedAt?.toISOString() ?? null,
  group: label.group,
});
