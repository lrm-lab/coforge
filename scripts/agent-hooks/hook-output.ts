// The PreToolUse hook reply shared by the hooks in this directory.
export type Decision =
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "context"; text: string }
  | { kind: "allow" };

export function respond(d: Decision) {
  if (d.kind === "deny" || d.kind === "ask")
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.kind, permissionDecisionReason: d.reason } }));
  else if (d.kind === "context")
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: d.text } }));
}
