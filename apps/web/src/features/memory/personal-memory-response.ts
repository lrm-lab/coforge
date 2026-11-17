import * as m from "#src/paraglide/messages";
import { memoryError } from "./memory-copy";
import type { personalMemoryCommand } from "./personal-memory.functions";

export function personalResponseError(
  response: Awaited<ReturnType<typeof personalMemoryCommand>>,
): string | undefined {
  if (response.status === "ready")
    return response.result.status === "failed" ? memoryError(response.result.error) : undefined;
  if (response.status === "offline") return m.memory_offline();
  if (response.status === "unsupported") return m.memory_unsupported();
  if (response.status === "timeout") return m.memory_timeout();
  return m.memory_forbidden();
}
