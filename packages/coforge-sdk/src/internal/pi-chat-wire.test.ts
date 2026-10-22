import { expect, test } from "bun:test";
import {
  decodePiChatRequest,
  encodePiChatRequest,
  decodePiChatFrame,
  encodePiChatFrame,
  piChatFrames,
  PiChatFrameAssembly,
} from "./pi-chat-wire";

const scope = {
  workspaceId: crypto.randomUUID(),
  computerId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
};
test("Pi chat commands use the authenticated scope and a versioned, bounded wire envelope", () => {
  const request = {
    ...scope,
    requestId: crypto.randomUUID(),
    command: { action: "list" as const },
  };
  expect(decodePiChatRequest(encodePiChatRequest(request))).toEqual(request);
  expect(() => encodePiChatRequest({ ...request, userId: "../someone" })).toThrow();
  expect(() =>
    decodePiChatRequest(
      encodePiChatFrame(piChatFrames(scope, request.requestId, "result", { ok: true })[0]!),
    ),
  ).toThrow();
});
test("large Unicode tool results cross WSS as bounded frames and reassemble without loss", () => {
  const body = { messages: [{ text: "工具输出 🛠️\n".repeat(100_000) }] };
  const frames = piChatFrames(scope, crypto.randomUUID(), "result", body);
  expect(frames.length).toBeGreaterThan(1);
  const assembly = new PiChatFrameAssembly();
  let actual: unknown;
  for (const frame of frames.toReversed()) {
    const encoded = encodePiChatFrame(frame);
    expect(encoded.byteLength).toBeLessThan(300_000);
    actual = assembly.accept(decodePiChatFrame(encoded)) ?? actual;
  }
  expect(actual).toEqual(body);
});
test("an assembly rejects mixed scopes, conflicting duplicates and oversized payloads", () => {
  const frames = piChatFrames(scope, crypto.randomUUID(), "event", { text: "x".repeat(500_000) });
  const assembly = new PiChatFrameAssembly();
  assembly.accept(frames[0]!);
  expect(() => assembly.accept({ ...frames[1]!, userId: crypto.randomUUID() })).toThrow();
  expect(() => assembly.accept({ ...frames[0]!, data: new Uint8Array([1]) })).toThrow();
  expect(() =>
    piChatFrames(scope, crypto.randomUUID(), "result", "x".repeat(32_000_001)),
  ).toThrow();
});
test("multipart delivery stays live while chunks arrive and expires only after an idle interval", () => {
  const body = { text: "x".repeat(750_000) };
  const frames = piChatFrames(scope, crypto.randomUUID(), "event", body);
  const assembly = new PiChatFrameAssembly();
  assembly.accept(frames[0]!, 0);
  expect(assembly.isIdle(20_000)).toBe(false);
  assembly.accept(frames[1]!, 20_000);
  expect(assembly.isIdle(40_000)).toBe(false);
  expect(assembly.accept(frames[2]!, 40_000)).toEqual(body);
  expect(assembly.isIdle(70_001)).toBe(true);
});
