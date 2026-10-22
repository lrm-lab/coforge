import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import {
  PiChatRequestSchema,
  PiChatFrameSchema,
} from "#src/internal/gen/coforge/rpc/v1/pi_chat_pb";
import {
  piChatCommandSchema,
  piChatScopeSchema,
  type PiChatCommand,
  type PiChatScope,
} from "./pi-chat";
import { RPC_METHODS } from "./rpc-methods";

export const PI_CHAT_EXECUTE_METHOD = RPC_METHODS.daemonPiChatExecute;
export const PI_CHAT_FRAME_METHOD = RPC_METHODS.daemonPiChatFrame;
export const PI_CHAT_CAPABILITY = "pi-chat:v1";
export const PI_CHAT_CONTROLS_CAPABILITY = "pi-chat-controls:v1";
export const PI_CHAT_MAX_BYTES = 32_000_000;
export const PI_CHAT_PART_BYTES = 256_000;
export const PI_CHAT_MAX_PARTS = Math.ceil(PI_CHAT_MAX_BYTES / PI_CHAT_PART_BYTES);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const requestSchema = piChatScopeSchema.extend({
  requestId: z.uuid(),
  command: piChatCommandSchema,
});
export type PiChatRequest = PiChatScope & { requestId: string; command: PiChatCommand };
export type PiChatFrame = PiChatScope & {
  frameId: string;
  kind: "result" | "event";
  part: number;
  parts: number;
  data: Uint8Array;
};

export function encodePiChatRequest(input: PiChatRequest) {
  const { command, ...scope } = requestSchema.parse(input);
  const commandJson = encoder.encode(JSON.stringify(command));
  if (commandJson.length > 512_000) throw new Error("Pi chat command too large");
  return toBinary(
    PiChatRequestSchema,
    create(PiChatRequestSchema, {
      ...scope,
      protocolMajor: 1,
      messageType: "coforge.rpc.v1.PiChatRequest",
      commandJson,
    }),
  );
}
export function decodePiChatRequest(bytes: Uint8Array): PiChatRequest {
  if (bytes.length > 513_000) throw new Error("Pi chat command too large");
  const value = fromBinary(PiChatRequestSchema, bytes);
  if (value.protocolMajor !== 1 || value.messageType !== "coforge.rpc.v1.PiChatRequest")
    throw new Error("Invalid Pi chat request");
  return requestSchema.parse({ ...value, command: JSON.parse(decoder.decode(value.commandJson)) });
}
function validFrame(value: PiChatFrame): PiChatFrame {
  piChatScopeSchema.parse(value);
  z.uuid().parse(value.frameId);
  if (
    !["result", "event"].includes(value.kind) ||
    !Number.isInteger(value.parts) ||
    value.parts < 1 ||
    value.parts > PI_CHAT_MAX_PARTS ||
    !Number.isInteger(value.part) ||
    value.part < 0 ||
    value.part >= value.parts ||
    value.data.length > PI_CHAT_PART_BYTES
  )
    throw new Error("Invalid Pi chat frame");
  return value;
}
export function encodePiChatFrame(input: PiChatFrame) {
  return toBinary(
    PiChatFrameSchema,
    create(PiChatFrameSchema, {
      ...validFrame(input),
      protocolMajor: 1,
      messageType: "coforge.rpc.v1.PiChatFrame",
    }),
  );
}
export function decodePiChatFrame(bytes: Uint8Array): PiChatFrame {
  if (bytes.length > PI_CHAT_PART_BYTES + 1024) throw new Error("Pi chat frame too large");
  const value = fromBinary(PiChatFrameSchema, bytes);
  if (value.protocolMajor !== 1 || value.messageType !== "coforge.rpc.v1.PiChatFrame")
    throw new Error("Invalid Pi chat frame");
  return validFrame({
    ...piChatScopeSchema.parse(value),
    frameId: value.frameId,
    kind: z.enum(["result", "event"]).parse(value.kind),
    part: value.part,
    parts: value.parts,
    data: value.data,
  });
}
export function samePiChatScope(a: PiChatScope, b: PiChatScope) {
  return a.workspaceId === b.workspaceId && a.computerId === b.computerId && a.userId === b.userId;
}
export function piChatFrames(
  scope: PiChatScope,
  frameId: string,
  kind: PiChatFrame["kind"],
  body: unknown,
): PiChatFrame[] {
  const bytes = encoder.encode(JSON.stringify(body));
  if (bytes.length > PI_CHAT_MAX_BYTES) throw new Error("Pi chat response too large");
  const parts = Math.max(1, Math.ceil(bytes.length / PI_CHAT_PART_BYTES));
  return Array.from({ length: parts }, (_, part) =>
    validFrame({
      ...piChatScopeSchema.parse(scope),
      frameId,
      kind,
      part,
      parts,
      data: bytes.slice(part * PI_CHAT_PART_BYTES, (part + 1) * PI_CHAT_PART_BYTES),
    }),
  );
}
/** One bounded frame assembly. Owners expire unfinished assemblies and bound their count. */
export class PiChatFrameAssembly {
  #first?: PiChatFrame;
  #lastActivity = 0;
  readonly #parts = new Map<number, Uint8Array>();
  isIdle(now = Date.now()) {
    return now - this.#lastActivity > 30_000;
  }
  accept(frame: PiChatFrame, now = Date.now()): unknown | undefined {
    validFrame(frame);
    const first = (this.#first ??= frame);
    if (
      frame.frameId !== first.frameId ||
      frame.kind !== first.kind ||
      frame.parts !== first.parts ||
      !samePiChatScope(frame, first)
    )
      throw new Error("Mixed Pi chat frames");
    const previous = this.#parts.get(frame.part);
    if (
      previous &&
      (previous.length !== frame.data.length ||
        previous.some((byte, index) => byte !== frame.data[index]))
    )
      throw new Error("Conflicting Pi chat frame");
    this.#parts.set(frame.part, frame.data);
    this.#lastActivity = now;
    if (this.#parts.size !== first.parts) return;
    const length = [...this.#parts.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (length > PI_CHAT_MAX_BYTES) throw new Error("Pi chat response too large");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (let index = 0; index < first.parts; index++) {
      const part = this.#parts.get(index)!;
      bytes.set(part, offset);
      offset += part.length;
    }
    return JSON.parse(decoder.decode(bytes)) as unknown;
  }
}
