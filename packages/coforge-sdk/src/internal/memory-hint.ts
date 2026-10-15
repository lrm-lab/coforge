import { MEMORY_DISPOSITION_TOOL, type MemoryHintDelivery } from "#src/agent/memory-disposition";

export function memoryHintMessage(value: MemoryHintDelivery | undefined) {
  if (!value) return undefined;
  if (!value.hint_id || value.tool !== MEMORY_DISPOSITION_TOOL)
    throw new Error("invalid Memory Hint delivery");
  return { hintId: value.hint_id, tool: value.tool };
}

export function readMemoryHint(value: { hintId: string; tool: string }): MemoryHintDelivery {
  if (!value.hintId || value.tool !== MEMORY_DISPOSITION_TOOL)
    throw new Error("invalid Memory Hint delivery");
  return { hint_id: value.hintId, tool: MEMORY_DISPOSITION_TOOL };
}
