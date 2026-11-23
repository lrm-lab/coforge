import { describe, expect, test } from "bun:test";
import { createInlineEmbedPool } from "#src/features/artifacts/inline-embed-pool";

type FakeNode = {
  isConnected: boolean;
  ownerDocument?: object;
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

function createFakeElement(
  options: { connected?: boolean; atomicMove?: boolean; ownerDocument?: object } = {},
): FakeNode {
  const { connected = true, atomicMove = true, ownerDocument } = options;
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
    ownerDocument,
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

  test("refuses cross-document moveBefore without throwing", () => {
    const docA = {};
    const docB = {};
    const pool = createInlineEmbedPool(4);
    const parking = createFakeElement({ connected: true, atomicMove: true, ownerDocument: docA });
    const hostA = createFakeElement({ connected: true, atomicMove: true, ownerDocument: docA });
    const hostB = createFakeElement({ connected: true, atomicMove: true, ownerDocument: docB });
    pool.setParkingContainer(parking as unknown as Element);

    const frame = makeFrame("a1", 1, true);
    frame.fakeIframe.ownerDocument = docA;
    pool.setVisible("s1", true, frame.cacheKey);
    expect(pool.attachFrame("s1", frame, hostA as unknown as Element)).toBe(true);
    expect(pool.attachFrame("s1", frame, hostB as unknown as Element)).toBe(false);
    expect(hostB.moveBeforeCount).toBe(0);
  });
});
