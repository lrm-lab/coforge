import { REMINDER_PROTOCOL_MAJOR } from "./reminder";
import { fromWireRequestId, toWireRequestId } from "./idempotency-key-wire";

export const optional = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([key, v]) => key !== "$typeName" && v !== undefined),
  );

export function toVersionedProto<T extends { idempotencyKey: string }>(value: T) {
  return { ...toWireRequestId(value), protocolMajor: REMINDER_PROTOCOL_MAJOR };
}

export function fromVersionedProto<T>(message: Record<string, unknown>): T {
  const { protocolMajor, ...wire } = optional(message);
  if (protocolMajor !== REMINDER_PROTOCOL_MAJOR) throw new Error("invalid reminder scope");
  return fromWireRequestId(wire as { requestId: string }) as T;
}
