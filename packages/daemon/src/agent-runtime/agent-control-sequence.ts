import type { AgentControlScope } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeRecord } from "./agent-runtime-state";

export const nextSequence = (
  record: Pick<AgentRuntimeRecord, "scope" | "sequence"> | undefined,
  scope: Pick<AgentControlScope, "epoch">,
): number => (record?.scope.epoch === scope.epoch ? record.sequence : 0) + 1;
