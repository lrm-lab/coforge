import { describe, expect, test } from "bun:test";
import {
  acceptBridgeMessage,
  BRIDGE,
  bridgeMessage,
  bridgeSrcDoc,
  newBridgeSession,
} from "#src/features/conversations/html-preview-bridge";

const frame = {} as Window;
const other = {} as Window;
const state = {
  type: "state",
  links: [{ href: "https://example.com/", x: 10, y: 20, w: 80, h: 18 }],
  scrollX: 0,
  scrollY: 120,
  viewportWidth: 800,
  viewportHeight: 600,
  documentWidth: 800,
  documentHeight: 3000,
};

describe("the page only listens to the frame it rendered, in its current session", () => {
  const session = newBridgeSession();
  const from = (source: unknown, data: Record<string, unknown>) =>
    acceptBridgeMessage({ source, data: { bridge: BRIDGE, ...session, ...data } }, frame, session);

  test("the frame's own messages are read", () => {
    expect(from(frame, { type: "ready" })).toEqual({ type: "ready" });
    expect(from(frame, state)).toEqual(state as never);
    expect(from(frame, { type: "quote", id: 1, quote: "Pricing" })).toEqual({
      type: "quote",
      id: 1,
      quote: "Pricing",
    });
    expect(from(frame, { type: "located", id: 2, box: null })).toEqual({
      type: "located",
      id: 2,
      box: null,
    });
  });

  test("another window, nonce or epoch, or an unknown shape, is ignored", () => {
    expect(from(other, { type: "ready" })).toBeNull();
    expect(from(undefined, { type: "ready" })).toBeNull();
    expect(from(frame, { type: "ready", nonce: "guessed" })).toBeNull();
    expect(from(frame, { type: "ready", epoch: session.epoch - 1 })).toBeNull();
    expect(from(frame, { type: "ready", bridge: "someone-else" })).toBeNull();
    expect(from(frame, { type: "render", html: "<p>" })).toBeNull();
    expect(from(frame, { ...state, scrollY: Number.NaN })).toBeNull();
    expect(from(frame, { type: "located", id: 2, box: { x: 1 } })).toBeNull();
    expect(from(frame, { ...state, links: [{ href: 1, x: 0, y: 0, w: 1, h: 1 }] })).toBeNull();
    expect(from(frame, { ...state, links: [{ href: "https://a.b/", x: 0 }] })).toBeNull();
    expect(acceptBridgeMessage({ source: frame, data: "ready" }, frame, session)).toBeNull();
    expect(acceptBridgeMessage({ source: frame, data: null }, null, session)).toBeNull();
  });
});

test("each render has its own nonce and a later epoch", () => {
  const first = newBridgeSession();
  const second = newBridgeSession();
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.nonce).toMatch(/^[A-Za-z0-9]{20,}$/);
  expect(second.epoch).toBeGreaterThan(first.epoch);
  expect(bridgeMessage(first, { type: "scrollTo", x: 0, y: 10 })).toEqual({
    bridge: BRIDGE,
    nonce: first.nonce,
    epoch: first.epoch,
    type: "scrollTo",
    x: 0,
    y: 10,
  });
});

test("the frame starts in standards mode with only the policy and the nonced bridge", () => {
  const session = newBridgeSession();
  const document = bridgeSrcDoc(session);
  expect(document.startsWith("<!doctype html>")).toBe(true);
  expect(document).toContain(`script-src 'nonce-${session.nonce}'`);
  expect(document).toContain("default-src 'none'");
  expect(document).toContain("base-uri 'none'");
  expect(document).toContain("form-action 'none'");
  // One script, the bridge's, and no way for its source to close the element early.
  expect(document.match(/<script/g)).toHaveLength(1);
  expect(document.match(/<\/script>/g)).toHaveLength(1);
  expect(document).toContain(`<script nonce="${session.nonce}">`);
  // The CSP comes before the bridge, so it governs everything after it.
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<script"));
});
