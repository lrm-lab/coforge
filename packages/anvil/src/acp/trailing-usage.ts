import type { AgentRuntimeEvent, AgentTurnTokenUsage } from "@coforge/agent";
import { acpContextUsage, acpUpdateTokenUsage } from "#src/acp-context-usage";

export class AcpTrailingUsageGate {
  #wake: (() => void) | undefined;

  wait(waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wake === finish) this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      this.#wake = finish;
    });
  }

  wake(): void {
    this.#wake?.();
  }
}

export function acpIdleUsageUpdateEvents(
  update: Readonly<Record<string, unknown>>,
  alreadyEmittedTokenUsage: boolean,
): { contextEvents: AgentRuntimeEvent[]; tokenUsage?: AgentTurnTokenUsage } {
  if (update.sessionUpdate !== "usage_update") return { contextEvents: [] };
  return {
    contextEvents: acpContextUsage(update),
    tokenUsage: alreadyEmittedTokenUsage ? undefined : acpUpdateTokenUsage(update),
  };
}
