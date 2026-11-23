import { describe, expect, test } from "bun:test";
import {
  INLINE_DEFAULT_HEIGHT_PX,
  INLINE_MAX_HEIGHT_PX,
  INLINE_MIN_HEIGHT_PX,
  clampInlineFrameHeight,
  nextInlineFrameHeight,
} from "#src/features/artifacts/artifact-page-theme";
import {
  INLINE_EMBED_MAX_ACTIVE,
  createInlineEmbedPool,
} from "#src/features/artifacts/inline-embed-pool";

describe("inline embed LRU pool", () => {
  test("activates visible slots up to the limit and evicts off-screen slots first", () => {
    const pool = createInlineEmbedPool(2);
    pool.setVisible("m1", true);
    pool.setVisible("m2", true);
    expect(pool.isActive("m1")).toBe(true);
    expect(pool.isActive("m2")).toBe(true);

    pool.setVisible("m1", false);
    expect(pool.isActive("m1")).toBe(true);

    pool.setVisible("m3", true);
    expect(pool.isActive("m1")).toBe(false);
    expect(pool.isActive("m2")).toBe(true);
    expect(pool.isActive("m3")).toBe(true);
  });

  test("evicts least recently used visible slot when all active slots remain in view", () => {
    const pool = createInlineEmbedPool(2);
    pool.setVisible("m1", true);
    pool.setVisible("m2", true);
    pool.setVisible("m1", true);
    pool.setVisible("m3", true);
    expect(pool.isActive("m1")).toBe(true);
    expect(pool.isActive("m2")).toBe(false);
    expect(pool.isActive("m3")).toBe(true);
  });

  test("releases slots on unmount and notifies subscribers only when state changes", () => {
    const pool = createInlineEmbedPool(INLINE_EMBED_MAX_ACTIVE);
    let notifications = 0;
    const unsubscribe = pool.subscribe(() => {
      notifications += 1;
    });
    pool.setVisible("m1", true);
    pool.setVisible("m1", true);
    expect(notifications).toBe(1);
    pool.release("m1");
    expect(pool.isActive("m1")).toBe(false);
    expect(notifications).toBe(2);
    unsubscribe();
    pool.setVisible("m2", true);
    expect(notifications).toBe(2);
  });

  test("remembers clamped heights per artifact version key with bounded capacity", () => {
    const pool = createInlineEmbedPool(2, 2);
    pool.rememberHeight("a1:1", 40);
    expect(pool.cachedHeight("a1:1")).toBe(INLINE_MIN_HEIGHT_PX);
    pool.rememberHeight("a2:1", 2000);
    expect(pool.cachedHeight("a2:1")).toBe(INLINE_MAX_HEIGHT_PX);
    pool.rememberHeight("a3:1", 320);
    expect(pool.cachedHeight("a1:1")).toBeUndefined();
    expect(pool.cachedHeight("a2:1")).toBe(INLINE_MAX_HEIGHT_PX);
    expect(pool.cachedHeight("a3:1")).toBe(320);
  });

  test("clamps invalid heights to default and valid heights within bounds", () => {
    expect(clampInlineFrameHeight(Number.NaN)).toBe(INLINE_DEFAULT_HEIGHT_PX);
    expect(clampInlineFrameHeight(0)).toBe(INLINE_DEFAULT_HEIGHT_PX);
    expect(clampInlineFrameHeight(50)).toBe(INLINE_MIN_HEIGHT_PX);
    expect(clampInlineFrameHeight(340.2)).toBe(341);
    expect(clampInlineFrameHeight(5000)).toBe(INLINE_MAX_HEIGHT_PX);
  });

  test("default pool keeps 16 loaded embeds mounted across scrolls and evicts off-screen slots on the 17th", () => {
    expect(INLINE_EMBED_MAX_ACTIVE).toBe(16);
    const pool = createInlineEmbedPool();
    for (let i = 1; i <= 16; i++) {
      pool.setVisible(`m${i}`, true);
      if (i <= 12) pool.setVisible(`m${i}`, false);
    }
    for (let i = 1; i <= 16; i++) expect(pool.isActive(`m${i}`)).toBe(true);
    pool.setVisible("m17", true);
    expect(pool.isActive("m1")).toBe(false);
    expect(pool.isActive("m17")).toBe(true);
    for (let i = 2; i <= 16; i++) expect(pool.isActive(`m${i}`)).toBe(true);
  });

  test("monotonic inline height fits initial compact cards, prevents tab-switch shrink jitter, and resets when host width changes", () => {
    let state = {
      height: INLINE_DEFAULT_HEIGHT_PX,
      settled: false,
      hostWidth: null as number | null,
    };
    state = nextInlineFrameHeight(state, 140, 896);
    expect(state).toEqual({ height: 140, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 510, 896);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 896);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 895);
    expect(state).toEqual({ height: 510, settled: true, hostWidth: 896 });

    state = nextInlineFrameHeight(state, 390, 893);
    expect(state).toEqual({ height: 390, settled: true, hostWidth: 893 });

    state = nextInlineFrameHeight(state, 620, 420);
    expect(state).toEqual({ height: 620, settled: true, hostWidth: 420 });

    state = nextInlineFrameHeight(state, 390, 896);
    expect(state).toEqual({ height: 390, settled: true, hostWidth: 896 });

    expect(nextInlineFrameHeight(state, 0, 896)).toEqual(state);
    expect(nextInlineFrameHeight(state, Number.NaN, 896)).toEqual(state);
  });
});

type FakeNode = {
  isConnected: boolean;
  parentElement: FakeNode | null;
  children: FakeNode[];
  appendCount: number;
  moveBeforeCount: number;
  removeCount: number;
  appendChild: (node: FakeNode) => FakeNode;
  replaceChildren: () => void;
  remove: () => void;
  moveBefore?: (node: FakeNode, child: FakeNode | null) => void;
};

function createFakeElement(options: { connected?: boolean; atomicMove?: boolean } = {}): FakeNode {
  const { connected = true, atomicMove = true } = options;
  const setConnected = (node: FakeNode, next: boolean) => {
    node.isConnected = next;
    for (const child of node.children) setConnected(child, next);
  };
  const detach = (node: FakeNode) => {
    if (!node.parentElement) return;
    const siblings = node.parentElement.children;
    const index = siblings.indexOf(node);
    if (index >= 0) siblings.splice(index, 1);
    node.parentElement = null;
  };
  const element: FakeNode = {
    isConnected: connected,
    parentElement: null,
    children: [],
    appendCount: 0,
    moveBeforeCount: 0,
    removeCount: 0,
    appendChild(node) {
      element.appendCount += 1;
      detach(node);
      node.parentElement = element;
      element.children.push(node);
      setConnected(node, element.isConnected);
      return node;
    },
    replaceChildren() {
      while (element.children.length > 0) {
        element.children[0]?.remove();
      }
    },
    remove() {
      element.removeCount += 1;
      detach(element);
      setConnected(element, false);
    },
  };
  if (atomicMove) {
    element.moveBefore = (node, child) => {
      if (!element.isConnected || !node.isConnected) throw new Error("HierarchyRequestError");
      element.moveBeforeCount += 1;
      detach(node);
      node.parentElement = element;
      if (child === null) {
        element.children.push(node);
      } else {
        const index = element.children.indexOf(child);
        if (index < 0) throw new Error("NotFoundError");
        element.children.splice(index, 0, node);
      }
    };
  }
  return element;
}

function makeFrame(artifactId: string, version = 1, ready = true) {
  const iframe = createFakeElement({ connected: false, atomicMove: true });
  return {
    cacheKey: `${artifactId}:${version}`,
    artifactId,
    version,
    iframe: iframe as unknown as HTMLIFrameElement,
    fakeIframe: iframe,
    link: {
      url: `https://a-${artifactId}.sandbox.test/_coforge/open?ticket=t-${artifactId}-${version}`,
      version,
      expiresAt: "2026-11-23T00:00:00.000Z",
      viewer: { displayName: "Ada", kind: "person" as const },
      level: "view" as const,
    },
    mountedOnce: false,
    ready,
    blocked: false,
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("inline embed live iframe parking", () => {
  test("parks ready iframes with moveBefore on unmount and reattaches them on return without reloading", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const hostA = createFakeElement({ connected: true, atomicMove: true });
    const hostB = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);
    expect(pool.canParkFrames()).toBe(true);

    const frame = makeFrame("a1", 1, true);
    pool.setVisible("slotA", true, frame.cacheKey);
    expect(pool.attachFrame("slotA", frame, hostA as unknown as Element)).toBe(true);
    expect(hostA.appendCount).toBe(1);
    expect(hostA.moveBeforeCount).toBe(0);
    expect(frame.fakeIframe.parentElement).toBe(hostA);

    pool.release("slotA");
    expect(pool.parkFrame(frame)).toBe(true);
    expect(parking.moveBeforeCount).toBe(1);
    expect(parking.appendCount).toBe(0);
    expect(frame.fakeIframe.parentElement).toBe(parking);
    expect(frame.fakeIframe.isConnected).toBe(true);
    expect(pool.hasParkedFrame("a1:1")).toBe(true);

    pool.setVisible("slotB", true, "a1:1");
    const claimed = pool.claimParkedFrame("slotB", "a1:1");
    expect(claimed).toBe(frame);
    expect(pool.hasParkedFrame("a1:1")).toBe(false);
    expect(pool.attachFrame("slotB", claimed!, hostB as unknown as Element)).toBe(true);
    expect(hostB.moveBeforeCount).toBe(1);
    expect(hostB.appendCount).toBe(0);
    expect(frame.fakeIframe.parentElement).toBe(hostB);
    expect(frame.fakeIframe.removeCount).toBe(0);
  });

  test("discards unready frames after microtask prune and discards blocked frames immediately", async () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const loadingFrame = makeFrame("a1", 1, false);
    pool.setVisible("s1", true, loadingFrame.cacheKey);
    pool.attachFrame("s1", loadingFrame, host as unknown as Element);
    pool.release("s1");
    expect(pool.parkFrame(loadingFrame)).toBe(false);
    expect(pool.hasParkedFrame("a1:1")).toBe(false);
    await flushMicrotasks();
    expect(loadingFrame.fakeIframe.removeCount).toBe(1);

    const blockedFrame = makeFrame("a2", 1, true);
    blockedFrame.blocked = true;
    pool.setVisible("s2", true, blockedFrame.cacheKey);
    pool.attachFrame("s2", blockedFrame, host as unknown as Element);
    pool.release("s2");
    expect(pool.parkFrame(blockedFrame)).toBe(false);
    expect(blockedFrame.fakeIframe.removeCount).toBe(1);
    expect(pool.hasParkedFrame("a2:1")).toBe(false);
  });

  test("survives StrictMode cold mount and at-capacity replay via moveBefore without re-appending single-use tickets", async () => {
    const pool = createInlineEmbedPool(1);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const coldFrame = makeFrame("a1", 1, false);
    pool.setVisible("s1", true, coldFrame.cacheKey);
    expect(pool.attachFrame("s1", coldFrame, host as unknown as Element)).toBe(true);
    expect(host.appendCount).toBe(1);

    expect(pool.parkFrame(coldFrame)).toBe(false);
    expect(coldFrame.fakeIframe.parentElement).toBe(parking);
    expect(coldFrame.fakeIframe.removeCount).toBe(0);

    expect(pool.attachFrame("s1", coldFrame, host as unknown as Element)).toBe(true);
    expect(host.appendCount).toBe(1);
    expect(host.moveBeforeCount).toBe(1);
    await flushMicrotasks();
    expect(coldFrame.fakeIframe.removeCount).toBe(0);
    expect(coldFrame.fakeIframe.parentElement).toBe(host);

    coldFrame.ready = true;
    expect(pool.parkFrame(coldFrame)).toBe(false);
    expect(pool.attachFrame("s1", coldFrame, host as unknown as Element)).toBe(true);
    expect(host.appendCount).toBe(1);
    expect(host.moveBeforeCount).toBe(2);
    await flushMicrotasks();
    expect(coldFrame.fakeIframe.removeCount).toBe(0);
  });

  test("rejects re-attaching a disconnected frame instead of re-appending a spent ticket", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const frame = makeFrame("a1", 1, true);
    pool.setVisible("s1", true, frame.cacheKey);
    expect(pool.attachFrame("s1", frame, host as unknown as Element)).toBe(true);
    frame.fakeIframe.remove();

    expect(pool.attachFrame("s1", frame, host as unknown as Element)).toBe(false);
    expect(host.appendCount).toBe(1);
  });

  test("falls back cleanly when moveBefore is unavailable while still preserving height cache", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: false });
    const host = createFakeElement({ connected: true, atomicMove: false });
    pool.setParkingContainer(parking as unknown as Element);
    expect(pool.canParkFrames()).toBe(false);

    pool.rememberHeight("a1:1", 420);
    const frame = makeFrame("a1", 1, true);
    pool.attachFrame("s1", frame, host as unknown as Element);
    expect(pool.parkFrame(frame)).toBe(false);
    expect(frame.fakeIframe.removeCount).toBe(1);
    expect(pool.claimParkedFrame("s2", "a1:1")).toBeNull();
    expect(pool.cachedHeight("a1:1")).toBe(420);
  });

  test("reserves returning parked frames across interleaved setVisible/attachFrame and evicts unreserved parked frames first", () => {
    const pool = createInlineEmbedPool(2);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host1 = createFakeElement({ connected: true, atomicMove: true });
    const host2 = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const f1 = makeFrame("a1", 1, true);
    const f2 = makeFrame("a2", 1, true);
    pool.setVisible("s1", true, f1.cacheKey);
    pool.attachFrame("s1", f1, host1 as unknown as Element);
    pool.setVisible("s2", true, f2.cacheKey);
    pool.attachFrame("s2", f2, host2 as unknown as Element);

    pool.release("s1");
    pool.parkFrame(f1);
    pool.release("s2");
    pool.parkFrame(f2);

    pool.setVisible("s1-return", true, "a1:1");
    pool.setVisible("s2-return", true, "a2:1");
    const reclaimed1 = pool.claimParkedFrame("s1-return", "a1:1");
    expect(reclaimed1).toBe(f1);
    pool.attachFrame("s1-return", reclaimed1!, host1 as unknown as Element);
    expect(pool.hasParkedFrame("a2:1")).toBe(true);

    const reclaimed2 = pool.claimParkedFrame("s2-return", "a2:1");
    expect(reclaimed2).toBe(f2);
    pool.attachFrame("s2-return", reclaimed2!, host2 as unknown as Element);
    expect(f1.fakeIframe.removeCount).toBe(0);
    expect(f2.fakeIframe.removeCount).toBe(0);

    pool.release("s1-return");
    pool.parkFrame(f1);
    pool.release("s2-return");
    pool.parkFrame(f2);

    pool.setVisible("s1-again", true, "a1:1");
    pool.setVisible("s3-other", true, "b1:1");
    expect(pool.hasParkedFrame("a1:1")).toBe(true);
    expect(pool.hasParkedFrame("a2:1")).toBe(false);
    expect(f2.fakeIframe.removeCount).toBe(1);
  });

  test("does not resurrect evicted slots when attachFrame or claimParkedFrame runs after eviction", () => {
    const pool = createInlineEmbedPool(1);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host1 = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const f1 = makeFrame("a1", 1, true);
    pool.setVisible("s1", true, "a1:1");
    pool.setVisible("s2", true, "a2:1");
    expect(pool.isActive("s1")).toBe(false);
    expect(pool.isActive("s2")).toBe(true);

    pool.attachFrame("s1", f1, host1 as unknown as Element);
    expect(pool.isActive("s1")).toBe(false);
    expect(pool.isActive("s2")).toBe(true);
  });

  test("returns unattached claimed frames to parking instead of leaking them", () => {
    const pool = createInlineEmbedPool(2);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const f1 = makeFrame("a1", 1, true);
    pool.setVisible("s1", true, "a1:1");
    pool.attachFrame("s1", f1, host as unknown as Element);
    pool.release("s1");
    pool.parkFrame(f1);

    pool.setVisible("s2", true, "a1:1");
    const claimed = pool.claimParkedFrame("s2", "a1:1");
    expect(claimed).toBe(f1);
    expect(pool.hasParkedFrame("a1:1")).toBe(false);

    pool.release("s2");
    pool.releaseClaimedIfUnattached(claimed!);
    expect(pool.hasParkedFrame("a1:1")).toBe(true);
  });

  test("handles duplicate embeds of the same artifact version independently", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host1 = createFakeElement({ connected: true, atomicMove: true });
    const host2 = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const first = makeFrame("a1", 1, true);
    const second = makeFrame("a1", 1, true);
    pool.attachFrame("s1", first, host1 as unknown as Element);
    pool.attachFrame("s2", second, host2 as unknown as Element);
    pool.parkFrame(first);
    pool.parkFrame(second);

    const claimedFirst = pool.claimParkedFrame("r1", "a1:1");
    const claimedSecond = pool.claimParkedFrame("r2", "a1:1");
    const claimedThird = pool.claimParkedFrame("r3", "a1:1");
    expect(claimedFirst).not.toBeNull();
    expect(claimedSecond).not.toBeNull();
    expect(claimedFirst).not.toBe(claimedSecond);
    expect(claimedThird).toBeNull();
  });

  test("evicts all versions of an artifact and clears everything on dispose", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const a1v1 = makeFrame("a1", 1, true);
    const a1v2 = makeFrame("a1", 2, true);
    const a2v1 = makeFrame("a2", 1, true);
    for (const frame of [a1v1, a1v2, a2v1]) {
      pool.attachFrame(frame.cacheKey, frame, host as unknown as Element);
      pool.parkFrame(frame);
    }

    pool.evictArtifact("a1");
    expect(pool.hasParkedFrame("a1:1")).toBe(false);
    expect(pool.hasParkedFrame("a1:2")).toBe(false);
    expect(a1v1.fakeIframe.removeCount).toBe(1);
    expect(a1v2.fakeIframe.removeCount).toBe(1);
    expect(pool.hasParkedFrame("a2:1")).toBe(true);

    pool.dispose();
    expect(pool.hasParkedFrame("a2:1")).toBe(false);
    expect(a2v1.fakeIframe.removeCount).toBe(1);
    expect(parking.children).toHaveLength(0);
  });

  test("reattaches a frame parked during a StrictMode cleanup cycle without duplicating it", () => {
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true });
    const host = createFakeElement({ connected: true, atomicMove: true });
    pool.setParkingContainer(parking as unknown as Element);

    const frame = makeFrame("a1", 1, true);
    pool.setVisible("s1", true, frame.cacheKey);
    pool.attachFrame("s1", frame, host as unknown as Element);
    pool.parkFrame(frame);
    expect(pool.hasParkedFrame("a1:1")).toBe(true);

    expect(pool.attachFrame("s1", frame, host as unknown as Element)).toBe(true);
    expect(pool.hasParkedFrame("a1:1")).toBe(false);
    expect(frame.fakeIframe.parentElement).toBe(host);
    expect(host.moveBeforeCount).toBe(1);
  });
});
