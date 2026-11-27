import { create, fromBinary, toBinary, type Message } from "@bufbuild/protobuf";
import {
  TerminalControlSchema,
  TerminalFrameSchema,
  type TerminalControl,
  type TerminalFrame,
} from "#src/internal/gen/coforge/rpc/v1/computer_terminal_pb";

import { RPC_METHODS } from "./rpc-methods";

export const COMPUTER_TERMINAL_CONTROL_MESSAGE_TYPE = "coforge.rpc.v1.TerminalControl";
export const COMPUTER_TERMINAL_FRAME_METHOD = RPC_METHODS.daemonComputerTerminalFrame;
export const COMPUTER_TERMINAL_CAPABILITY = "computer-terminal:v1";
export const TERMINAL_MAX_CHUNK_BYTES = 16 * 1024;
export const TERMINAL_MAX_HISTORY_BYTES = 1024 * 1024;
export const TERMINAL_MAX_DIMENSION = 500;

const MAX_WIRE_BYTES = TERMINAL_MAX_CHUNK_BYTES + 2048;
const MAX_UINT32 = 0xffff_ffff;
const VERSION = 1;
const errorCodes = new Set([
  "permission_denied",
  "unsupported",
  "capacity",
  "attach_conflict",
  "input_sequence",
  "snapshot_gap",
  "output_backpressure",
  "spawn_failed",
  "daemon_replaced",
]);
const closeReasons = new Set([
  "closed",
  "exited",
  "idle_timeout",
  "permission_denied",
  "output_backpressure",
  "daemon_replaced",
]);

export type TerminalScope = Pick<
  TerminalControl,
  | "protocolMajor"
  | "workspaceId"
  | "computerId"
  | "ownerUserId"
  | "sessionId"
  | "attachId"
  | "attachGeneration"
>;

type Payload<T> = T extends { case: infer Case; value: infer Value extends Message }
  ? { case: Case; value: Omit<Value, keyof Message> }
  : never;

export type ComputerTerminalControl = TerminalScope & {
  command: Payload<TerminalControl["command"]>;
};
export type ComputerTerminalFrame = TerminalScope & { event: Payload<TerminalFrame["event"]> };

function requireTerminal(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid computer terminal frame");
}

function validId(value: string): boolean {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function validInteger(value: number, max = MAX_UINT32, min = 1): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validDimensions({ cols, rows }: { cols: number; rows: number }): boolean {
  return validInteger(cols, TERMINAL_MAX_DIMENSION) && validInteger(rows, TERMINAL_MAX_DIMENSION);
}

function validBytes(bytes: Uint8Array, min = 1): boolean {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= min &&
    bytes.byteLength <= TERMINAL_MAX_CHUNK_BYTES
  );
}

function terminalScope({
  protocolMajor,
  workspaceId,
  computerId,
  ownerUserId,
  sessionId,
  attachId,
  attachGeneration,
}: TerminalScope): TerminalScope {
  requireTerminal(
    protocolMajor === VERSION &&
      validInteger(attachGeneration) &&
      [workspaceId, computerId, ownerUserId, sessionId, attachId].every(validId),
  );
  return {
    protocolMajor,
    workspaceId,
    computerId,
    ownerUserId,
    sessionId,
    attachId,
    attachGeneration,
  };
}

function parseControl(command: TerminalControl["command"]): ComputerTerminalControl["command"] {
  switch (command.case) {
    case "openOrAttach": {
      const { cols, rows, takeover } = command.value;
      requireTerminal(validDimensions(command.value) && typeof takeover === "boolean");
      return { case: command.case, value: { cols, rows, takeover } };
    }
    case "resize": {
      const { cols, rows } = command.value;
      requireTerminal(validDimensions(command.value));
      return { case: command.case, value: { cols, rows } };
    }
    case "input": {
      const { inputSeq, bytes } = command.value;
      requireTerminal(validInteger(inputSeq) && validBytes(bytes));
      return { case: command.case, value: { inputSeq, bytes } };
    }
    case "detach":
    case "close":
      return { case: command.case, value: {} };
    default:
      throw new Error("Invalid computer terminal command");
  }
}

function parseFrame(event: TerminalFrame["event"]): ComputerTerminalFrame["event"] {
  switch (event.case) {
    case "opened": {
      const { daemonInstanceId, shellKind, cols, rows, nextOutputSeq, historyUnavailable } =
        event.value;
      requireTerminal(
        validId(daemonInstanceId) &&
          validId(shellKind) &&
          validDimensions(event.value) &&
          validInteger(nextOutputSeq) &&
          typeof historyUnavailable === "boolean",
      );
      return {
        case: event.case,
        value: { daemonInstanceId, shellKind, cols, rows, nextOutputSeq, historyUnavailable },
      };
    }
    case "snapshot": {
      const { outputSeq, bytes, final } = event.value;
      requireTerminal(
        outputSeq === 0
          ? final && bytes instanceof Uint8Array && bytes.byteLength === 0
          : validInteger(outputSeq) && validBytes(bytes),
      );
      return { case: event.case, value: { outputSeq, bytes, final } };
    }
    case "output": {
      const { outputSeq, bytes } = event.value;
      requireTerminal(validInteger(outputSeq) && validBytes(bytes));
      return { case: event.case, value: { outputSeq, bytes } };
    }
    case "inputAccepted": {
      const { inputSeq } = event.value;
      requireTerminal(validInteger(inputSeq));
      return { case: event.case, value: { inputSeq } };
    }
    case "exit": {
      const { status } = event.value;
      requireTerminal(
        (status.case === "code" && validInteger(status.value, 255, 0)) ||
          (status.case === "signal" && /^SIG[A-Z0-9]{1,24}$/.test(status.value)),
      );
      return { case: event.case, value: { status } };
    }
    case "error": {
      const { code } = event.value;
      requireTerminal(errorCodes.has(code));
      return { case: event.case, value: { code } };
    }
    case "closed": {
      const { reason } = event.value;
      requireTerminal(closeReasons.has(reason));
      return { case: event.case, value: { reason } };
    }
    default:
      throw new Error("Invalid computer terminal event");
  }
}

export function encodeTerminalControl(input: ComputerTerminalControl): Uint8Array {
  const scope = terminalScope(input);
  const command = parseControl(create(TerminalControlSchema, input).command);
  return toBinary(
    TerminalControlSchema,
    create(TerminalControlSchema, {
      ...scope,
      command,
      messageType: COMPUTER_TERMINAL_CONTROL_MESSAGE_TYPE,
    }),
  );
}

export function decodeTerminalControl(bytes: Uint8Array): ComputerTerminalControl {
  requireTerminal(bytes.byteLength <= MAX_WIRE_BYTES);
  const frame = fromBinary(TerminalControlSchema, bytes);
  requireTerminal(frame.messageType === COMPUTER_TERMINAL_CONTROL_MESSAGE_TYPE);
  return { ...terminalScope(frame), command: parseControl(frame.command) };
}

export function encodeTerminalFrame(input: ComputerTerminalFrame): Uint8Array {
  const scope = terminalScope(input);
  const event = parseFrame(create(TerminalFrameSchema, input).event);
  return toBinary(TerminalFrameSchema, create(TerminalFrameSchema, { ...scope, event }));
}

export function decodeTerminalFrame(bytes: Uint8Array): ComputerTerminalFrame {
  requireTerminal(bytes.byteLength <= MAX_WIRE_BYTES);
  const frame = fromBinary(TerminalFrameSchema, bytes);
  return { ...terminalScope(frame), event: parseFrame(frame.event) };
}
