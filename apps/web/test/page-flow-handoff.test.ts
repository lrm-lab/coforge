import { expect, test } from "bun:test";

import {
  acquirePageFlowHandoff,
  activePageFlowDepth,
  isTopPageFlowEntry,
} from "#src/lib/page-flow-handoff";

function fakeElement() {
  const attrs = new Map<string, string>();
  const style: Record<string, string> = {
    position: "",
    top: "",
    left: "",
    right: "",
    width: "",
    visibility: "",
    pointerEvents: "",
  };
  const el = {
    style,
    inert: false,
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
  } as unknown as HTMLElement;
  return { el, style, attrs };
}

function fakeEnv(startScrollY: number) {
  let scrollY = startScrollY;
  const root = fakeElement();
  const win = {
    get scrollY() {
      return scrollY;
    },
    scrollTo(_x: number, y: number) {
      scrollY = y;
    },
  };
  return { root: root.el, rootStyle: root.style, win, setScrollY: (y: number) => (scrollY = y) };
}

test("pins and hides the background root, hands off initial scroll, and restores without jump", () => {
  const env = fakeEnv(420);
  const handoff = acquirePageFlowHandoff({
    root: env.root,
    win: env.win,
    initialScrollTop: 85,
  });

  expect(activePageFlowDepth()).toBe(1);
  expect(isTopPageFlowEntry(handoff.id)).toBe(true);
  expect(env.rootStyle.position).toBe("fixed");
  expect(env.rootStyle.top).toBe("-420px");
  expect(env.rootStyle.visibility).toBe("hidden");
  expect(env.rootStyle.pointerEvents).toBe("none");
  expect(env.root.inert).toBe(true);
  expect(env.win.scrollY).toBe(85);

  env.setScrollY(310);
  let handedBack: number | undefined;
  handoff.release((y) => {
    handedBack = y;
  });

  expect(handedBack).toBe(310);
  expect(activePageFlowDepth()).toBe(0);
  expect(env.rootStyle.position).toBe("");
  expect(env.rootStyle.top).toBe("");
  expect(env.rootStyle.visibility).toBe("");
  expect(env.root.inert).toBe(false);
  expect(env.win.scrollY).toBe(420);
});

test("nested handoffs pin the outer layer and restore scroll positions in LIFO and out-of-order release", () => {
  const env = fakeEnv(200);
  const outerLayer = fakeElement();
  const innerLayer = fakeElement();

  const outer = acquirePageFlowHandoff({
    root: env.root,
    win: env.win,
    layerEl: outerLayer.el,
  });
  env.setScrollY(150);
  const inner = acquirePageFlowHandoff({
    root: env.root,
    win: env.win,
    layerEl: innerLayer.el,
  });

  expect(activePageFlowDepth()).toBe(2);
  expect(isTopPageFlowEntry(outer.id)).toBe(false);
  expect(isTopPageFlowEntry(inner.id)).toBe(true);
  expect(outerLayer.style.visibility).toBe("hidden");
  expect(outerLayer.style.top).toBe("-150px");
  expect(env.win.scrollY).toBe(0);

  inner.release();
  expect(activePageFlowDepth()).toBe(1);
  expect(outerLayer.style.visibility).toBe("");
  expect(env.rootStyle.visibility).toBe("hidden");
  expect(env.win.scrollY).toBe(150);

  outer.release();
  expect(activePageFlowDepth()).toBe(0);
  expect(env.rootStyle.visibility).toBe("");
  expect(env.win.scrollY).toBe(200);

  const env2 = fakeEnv(333);
  const a = acquirePageFlowHandoff({ root: env2.root, win: env2.win });
  env2.setScrollY(77);
  const b = acquirePageFlowHandoff({ root: env2.root, win: env2.win });
  a.release();
  b.release();
  expect(env2.win.scrollY).toBe(333);
  expect(env2.rootStyle.visibility).toBe("");
});

test("manageInert: false pins and hides without mutating or restoring inert", () => {
  const env = fakeEnv(120);
  env.root.inert = true;

  const handoff = acquirePageFlowHandoff({
    root: env.root,
    win: env.win,
    manageInert: false,
  });

  expect(env.rootStyle.visibility).toBe("hidden");
  expect(env.root.inert).toBe(true);

  env.root.inert = false;
  handoff.release();

  expect(env.rootStyle.visibility).toBe("");
  expect(env.root.inert).toBe(false);
  expect(env.win.scrollY).toBe(120);
});
