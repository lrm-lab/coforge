import { expect } from "bun:test";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";

/** What one control publication asks for, and which request it carries: the at-least-once
 * transport publishes duplicates, and the tests read the sequence through these. */
function decodePrimitive(bytes: Uint8Array) {
  try {
    decodeAgentStopIntent(bytes);
    return "stop";
  } catch {}
  try {
    decodeAgentWorkspaceResetRequest(bytes);
    return "workspace-reset";
  } catch {}
  decodeAgentStartIntent(bytes);
  return "start";
}

export function logicalControlSteps(publications: Uint8Array[]) {
  // Control transport is at-least-once; duplicate publications must preserve
  // the stable request and payload, while Daemon performs the operation once.
  const seen = new Map<string, string>();
  return publications.flatMap((bytes) => {
    const step = decodePrimitive(bytes);
    const requestId = decodeControlRequestId(bytes);
    const key = `${step}:${requestId}`;
    const encoded = bytes.toBase64();
    const previous = seen.get(key);
    if (previous !== undefined) {
      expect(encoded).toBe(previous);
      return [];
    }
    seen.set(key, encoded);
    return [step];
  });
}

function decodeControlRequestId(bytes: Uint8Array) {
  for (const decode of [
    decodeAgentStopIntent,
    decodeAgentWorkspaceResetRequest,
    decodeAgentStartIntent,
  ]) {
    try {
      return decode(bytes).requestId;
    } catch {}
  }
  throw new Error("Unknown control publication");
}
