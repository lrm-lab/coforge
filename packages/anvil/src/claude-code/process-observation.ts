import type { AgentSessionExit } from "@coforge/agent";
import type { JsonlProcess } from "#src/jsonl-process";
import { isClaudeMissingSessionLine, isClaudeMissingSessionResult } from "./resume-diagnostics";

export const CLAUDE_PROCESS_EXITED = "code agent process exited unexpectedly";

export function observeClaudeProcess(
  process: JsonlProcess,
  expectedSessionId: string | undefined,
  ports: {
    isCurrent(): boolean;
    beforeProgress(): boolean;
    accept(record: Readonly<Record<string, unknown>>): void;
    onFailure(error: Error): void;
    recoverMissingSession(): boolean;
    onClose(exit: AgentSessionExit | undefined, failure: Error | undefined): void;
  },
): void {
  let missing = false;
  let otherDiagnostic = false;
  let failure: Error | undefined;
  process.onStderr((line) => {
    if (expectedSessionId && isClaudeMissingSessionLine(line, expectedSessionId)) missing = true;
    else if (line.trim()) otherDiagnostic = true;
  });
  process.onRecord((record) => {
    if (!ports.isCurrent()) return;
    if (
      expectedSessionId &&
      ports.beforeProgress() &&
      isClaudeMissingSessionResult(record, expectedSessionId)
    ) {
      missing = true;
      return;
    }
    ports.accept(record);
  });
  process.onFailure((error) => {
    failure = error;
    if (error.message !== CLAUDE_PROCESS_EXITED) ports.onFailure(error);
  });
  process.onClose((exit) => {
    if (!ports.isCurrent()) return;
    if (
      missing &&
      !otherDiagnostic &&
      failure?.message === CLAUDE_PROCESS_EXITED &&
      ports.recoverMissingSession()
    )
      return;
    ports.onClose(exit, failure);
  });
}
