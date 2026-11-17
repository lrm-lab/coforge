import { expect, test } from "bun:test";

import {
  EMBEDDED_DESKTOP_IDLE_SLEEP_MS,
  embeddedDesktopIdleCountdownActive,
  embeddedDesktopStreamActive,
  reduceEmbeddedDesktop,
  type EmbeddedDesktopPhase,
} from "#src/features/computers/embedded-desktop-session";

test("wake opens maximized; collapse keeps the stream in activeMini; idle sleep disconnects", () => {
  let phase: EmbeddedDesktopPhase = "sleeping";
  expect(embeddedDesktopStreamActive(phase)).toBe(false);
  expect(embeddedDesktopIdleCountdownActive(phase)).toBe(false);

  phase = reduceEmbeddedDesktop(phase, "wake");
  expect(phase).toBe("maximized");
  expect(embeddedDesktopStreamActive(phase)).toBe(true);
  expect(embeddedDesktopIdleCountdownActive(phase)).toBe(false);

  phase = reduceEmbeddedDesktop(phase, "collapse");
  expect(phase).toBe("activeMini");
  expect(embeddedDesktopStreamActive(phase)).toBe(true);
  expect(embeddedDesktopIdleCountdownActive(phase)).toBe(true);

  phase = reduceEmbeddedDesktop(phase, "wake");
  expect(phase).toBe("maximized");

  phase = reduceEmbeddedDesktop(phase, "collapse");
  phase = reduceEmbeddedDesktop(phase, "idleExpired");
  expect(phase).toBe("sleeping");
  expect(embeddedDesktopStreamActive(phase)).toBe(false);
});

test("explicit sleep from any active phase disconnects the stream", () => {
  expect(reduceEmbeddedDesktop("maximized", "sleep")).toBe("sleeping");
  expect(reduceEmbeddedDesktop("activeMini", "sleep")).toBe("sleeping");
  expect(reduceEmbeddedDesktop("sleeping", "collapse")).toBe("sleeping");
});

test("the idle sleep budget is one minute", () => {
  expect(EMBEDDED_DESKTOP_IDLE_SLEEP_MS).toBe(60_000);
});
