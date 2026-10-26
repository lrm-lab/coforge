import type { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { asRecord } from "@lrm/coforge-anvil";

/** One native initialize exchange; the Session owns current-process and recovery state. */
export async function initializeClaudeSession(
  process: JsonlProcess,
  options: {
    initialized(): void;
    replacementReady(): Promise<void> | undefined;
  },
): Promise<void> {
  const requestId = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    let unsubscribeRecord: () => void = () => undefined;
    let unsubscribeFailure: () => void = () => undefined;
    let unsubscribeClose: () => void = () => undefined;
    let failure = new Error("Claude Code initialization process closed");
    const cleanup = () => {
      unsubscribeRecord();
      unsubscribeFailure();
      unsubscribeClose();
    };
    unsubscribeRecord = process.onRecord((record) => {
      const response = asRecord(record.response);
      if (record.type !== "control_response" || response?.request_id !== requestId) return;
      cleanup();
      if (response.subtype === "success") {
        // SDKControlInitializeResponse advertises commands, not all loaded skills.
        // Hidden model-invocable skills need not appear; an empty list is valid.
        const commands = asRecord(response.response)?.commands;
        if (
          !Array.isArray(commands) ||
          !commands.every((value: unknown) => {
            const command = asRecord(value);
            return (
              typeof command?.name === "string" &&
              typeof command.description === "string" &&
              typeof command.argumentHint === "string"
            );
          })
        ) {
          reject(new Error("Claude Code initialization returned invalid commands"));
          return;
        }
        options.initialized();
        resolve();
      } else {
        reject(new Error("Claude Code initialization was rejected"));
      }
    });
    unsubscribeFailure = process.onFailure((error) => {
      failure = error;
      if (error.message !== "code agent process exited unexpectedly") {
        cleanup();
        reject(error);
      }
    });
    unsubscribeClose = process.onClose(() => {
      cleanup();
      const replacement = options.replacementReady();
      if (replacement) void replacement.then(resolve, reject);
      else reject(failure);
    });
    void process
      .send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      })
      .catch((error: unknown) => {
        cleanup();
        reject(error);
      });
  });
}
