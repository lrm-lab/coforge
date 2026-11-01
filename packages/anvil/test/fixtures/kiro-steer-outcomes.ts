type Update = (value: object) => void;

/**
 * The steering outcomes a synchronous update tap can deliver before the `_session/steer` answer
 * that names their steer.
 */
export function steeringOutcomesBeforeAnswer(message: string, messageId: string, update: Update) {
  if (message.includes("steer-inject-before-answer"))
    update({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_injected", messageId } },
    });
  if (message.includes("steer-clear-before-answer"))
    update({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_cleared", messageIds: [messageId] } },
    });
}

/**
 * A real turn boundary decides whether Kiro gets to inject before its own buffer clears; these
 * keywords each drive one side of that outcome deterministically for the test.
 */
export function steeringOutcomesAfterAnswer(message: string, messageId: string, update: Update) {
  if (message.includes("steer-inject-then-clear")) {
    update({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_injected", messageId, content: message } },
    });
    update({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_cleared", messageIds: [messageId] } },
    });
  } else if (message.includes("steer-clear-without-inject")) {
    update({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_cleared", messageIds: [messageId] } },
    });
  }
}
