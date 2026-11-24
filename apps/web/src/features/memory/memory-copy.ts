import * as m from "#src/paraglide/messages";
import type { MemoryKind } from "@lrm/coforge-sdk/agent";

export function memoryError(code: string) {
  switch (code) {
    case "disabled":
      return m.memory_disabled();
    case "review_disabled":
      return m.memory_review_disabled();
    case "forbidden":
      return m.memory_forbidden();
    case "not_found":
      return m.memory_not_found();
    case "conflict":
      return m.memory_conflict();
    case "invalid":
      return m.memory_invalid();
    default:
      return m.memory_failed();
  }
}
export function memoryKind(kind: MemoryKind) {
  switch (kind) {
    case "fact":
      return m.memory_fact();
    case "decision":
      return m.memory_decision();
    case "preference":
      return m.memory_preference();
    case "experience":
      return m.memory_experience();
  }
}
