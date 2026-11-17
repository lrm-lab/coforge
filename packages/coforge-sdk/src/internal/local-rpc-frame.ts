/** Maximum payload size (4 MiB) permitted in a single length-prefixed local RPC frame. */
export const MAX_LOCAL_RPC_FRAME_BYTES = 4 * 1024 * 1024;

export class LocalRpcFrameTooLargeError extends RangeError {
  readonly frameBytes: number;

  constructor(frameBytes: number, direction: "encode" | "decode") {
    super(
      `local RPC frame size ${frameBytes} exceeds limit ${MAX_LOCAL_RPC_FRAME_BYTES} (${direction})`,
    );
    this.name = "LocalRpcFrameTooLargeError";
    this.frameBytes = frameBytes;
  }
}

export function frameLocalRpc(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_LOCAL_RPC_FRAME_BYTES) {
    throw new LocalRpcFrameTooLargeError(payload.byteLength, "encode");
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

export function readLocalRpcFrame(buffer: Uint8Array): Uint8Array | null {
  if (buffer.byteLength < 4) return null;
  const size = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
  if (size > MAX_LOCAL_RPC_FRAME_BYTES) {
    throw new LocalRpcFrameTooLargeError(size, "decode");
  }
  if (buffer.byteLength < size + 4) return null;
  return buffer.slice(4, size + 4);
}

export function readLocalRpcFrames(buffer: Uint8Array): {
  frames: Uint8Array[];
  remainder: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let remainder = buffer;
  while (true) {
    const frame = readLocalRpcFrame(remainder);
    if (!frame) break;
    frames.push(frame);
    remainder = remainder.slice(frame.byteLength + 4);
  }
  return { frames, remainder };
}
