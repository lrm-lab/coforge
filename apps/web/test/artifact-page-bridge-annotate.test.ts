import { describe, expect, test } from "bun:test";
import {
  createPageBridge,
  type PageBridgeHost,
} from "#src/features/artifacts/artifact-page-bridge";
import type { PageAnnotationEvent } from "#src/features/artifacts/artifact-page-bridge-annotate";
import { MARKS_MAX } from "#src/features/artifacts/artifact-page-annotations";

const ORIGIN = "https://a-11111111-1111-4111-8111-111111111111.sandbox.example";
const RECT = { top: 10, right: 90, bottom: 30, left: 50, width: 40, height: 20 };

function setup(overrides: Partial<PageBridgeHost> = {}) {
  const posted: Record<string, unknown>[] = [];
  const frameWindow = {
    postMessage: (message: Record<string, unknown>, target: string) => {
      expect(target).toBe(ORIGIN);
      posted.push(message);
    },
  } as unknown as Window;
  const host: PageBridgeHost = {
    level: "interact",
    data: { call: async () => ({}), subscribe: () => () => {} },
    assets: { list: async () => ({}), upload: async () => ({}), delete: async () => ({}) },
    viewer: { displayName: "Lin Xia", kind: "person" },
    artifact: { id: "a1", title: "Launch", version: 3, entryPath: "index.html" },
    theme: () => "light",
    userActive: () => true,
    copyText: async () => true,
    downloadFile: () => {},
    confirm: async () => true,
    openLink: () => {},
    suggestComment: () => true,
    reportError: () => {},
    reportFind: () => {},
    frameStatus: () => {},
    now: () => 0,
    ...overrides,
  };
  const bridge = createPageBridge(host, { origin: ORIGIN, window: () => frameWindow });
  const events: PageAnnotationEvent[] = [];
  bridge.annotations.listen((event) => events.push(event));
  const tell = (method: string, params: object, source: unknown = frameWindow, origin = ORIGIN) =>
    bridge.handle({
      source: source as MessageEventSource,
      origin,
      data: { jsonrpc: "2.0", method: `coforge/notifications/${method}`, params },
    });
  const sent = (method: string) => posted.filter((message) => message.method === method);
  return { bridge, events, tell, posted, sent, frameWindow };
}

const element = (selector = "main > p:nth-of-type(2)", quote = "Hello") => ({
  type: "element",
  data: { selector, quote },
  rect: RECT,
});
const text = (quote = "beta on Friday") => ({
  type: "text",
  data: { quote, prefix: "Ship the ", suffix: "." },
  rect: RECT,
});

describe("the annotation channel", () => {
  test("a pick is accepted each time a person acts while the host keeps picking on", async () => {
    let active = true;
    const { bridge, events, tell } = setup({ userActive: () => active });
    await tell("annotate-selected", element());
    expect(events).toEqual([]);

    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    active = false;
    await tell("annotate-selected", element());
    expect(events).toEqual([]);

    active = true;
    await tell("annotate-selected", element());
    expect(events).toEqual([
      {
        kind: "selected",
        anchor: { type: "element", data: { selector: "main > p:nth-of-type(2)", quote: "Hello" } },
        rect: RECT,
      },
    ]);

    await tell("annotate-selected", element("#second"));
    expect(events).toHaveLength(2);

    bridge.annotations.configure({ picking: false, selecting: true, showMarks: true });
    await tell("annotate-selected", element("#third"));
    expect(events).toHaveLength(2);
  });

  test("a pick carries the click point and the element's ancestors, outermost first, ending at the element", async () => {
    const { bridge, events, tell } = setup();
    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    const OUTER = { top: 0, right: 600, bottom: 300, left: 0, width: 600, height: 300 };
    await tell("annotate-selected", {
      ...element("#card > h2", "Launch plan"),
      name: "h2",
      point: { x: 60, y: 20 },
      path: [
        { name: "section.hero", data: { selector: "section.hero" }, rect: OUTER },
        {
          name: "div#card",
          data: { selector: "#card", quote: "Launch plan Ship it" },
          rect: OUTER,
        },
      ],
    });
    expect(events).toEqual([
      {
        kind: "selected",
        anchor: { type: "element", data: { selector: "#card > h2", quote: "Launch plan" } },
        rect: RECT,
        point: { x: 60, y: 20 },
        trail: [
          {
            name: "section.hero",
            anchor: { type: "element", data: { selector: "section.hero" } },
            rect: OUTER,
          },
          {
            name: "div#card",
            anchor: { type: "element", data: { selector: "#card", quote: "Launch plan Ship it" } },
            rect: OUTER,
          },
          {
            name: "h2",
            anchor: { type: "element", data: { selector: "#card > h2", quote: "Launch plan" } },
            rect: RECT,
          },
        ],
      },
    ]);
  });

  test("a text selection is accepted in comment mode, picking or not, and never as an element", async () => {
    const { bridge, events, tell } = setup();
    await tell("annotate-selected", text());
    expect(events).toEqual([]);

    bridge.annotations.configure({ picking: false, selecting: true, showMarks: true });
    await tell("annotate-selected", element());
    expect(events).toEqual([]);
    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    await tell("annotate-selected", text());
    expect(events).toEqual([
      {
        kind: "selected",
        anchor: {
          type: "text",
          data: { quote: "beta on Friday", prefix: "Ship the ", suffix: "." },
        },
        rect: RECT,
      },
    ]);
  });

  test("a selection that breaks the limits is dropped", async () => {
    const { bridge, events, tell } = setup();
    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    const bad = [
      element("x".repeat(1001)),
      element(""),
      element("p", "q".repeat(121)),
      { ...element(), data: { selector: "p", extra: 1 } },
      { ...element(), rect: { ...RECT, width: Number.NaN } },
      { ...element(), rect: { top: 1 } },
      { ...element(), name: "x".repeat(41) },
      { ...element(), name: "" },
      { ...element(), name: "li\u202Etpircs" },
      { ...element(), path: [{ name: "div\u2066x", data: { selector: "div" }, rect: RECT }] },
      { ...element(), point: { x: Number.NaN, y: 0 } },
      { ...element(), point: { x: 1, y: 2, z: 3 } },
      {
        ...element(),
        path: Array.from({ length: 9 }, () => ({
          name: "div",
          data: { selector: "div" },
          rect: RECT,
        })),
      },
      { ...element(), path: [{ name: "div", data: { selector: "div", extra: 1 }, rect: RECT }] },
      { ...element(), path: [{ name: "div", data: { selector: "x".repeat(1001) }, rect: RECT }] },
      { ...element(), path: [{ data: { selector: "div" }, rect: RECT }] },
      { ...text(), point: { x: 1, y: 2 } },
      { ...text(), path: [] },
      { ...text("q".repeat(4001)) },
      { ...text(), data: { quote: "ok", prefix: "p".repeat(65) } },
      { ...text(), data: { quote: "" } },
      { type: "lines", data: { start: 1, end: 2 }, rect: RECT },
      { type: "file", data: {}, rect: RECT },
      { data: { selector: "p" }, rect: RECT },
      "text",
    ];
    for (const params of bad) await tell("annotate-selected", params as object);
    expect(events).toEqual([]);
  });

  test("messages from another window or origin are ignored", async () => {
    const { bridge, events, tell } = setup();
    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    await tell("annotate-selected", element(), {});
    await tell("annotate-selected", element(), undefined, "https://evil.example");
    expect(events).toEqual([]);
  });

  test("a click the page cannot anchor and a cleared selection report only when they can apply", async () => {
    let active = true;
    const { bridge, events, tell } = setup({ userActive: () => active });
    await tell("annotate-unanchorable", {});
    await tell("annotate-unselected", {});
    expect(events).toEqual([]);

    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    await tell("annotate-unanchorable", {});
    await tell("annotate-unanchorable", {});
    expect(events).toEqual([{ kind: "unanchorable" }, { kind: "unanchorable" }]);
    active = false;
    await tell("annotate-unanchorable", {});
    expect(events).toHaveLength(2);
    active = true;
    events.length = 1;
    bridge.annotations.configure({ picking: false, selecting: true, showMarks: true });
    await tell("annotate-unanchorable", {});
    expect(events).toHaveLength(1);
    await tell("annotate-unselected", {});
    expect(events.at(-1)).toEqual({ kind: "unselected" });
    bridge.annotations.configure({ picking: false, selecting: false, showMarks: false });
    await tell("annotate-unselected", {});
    expect(events).toHaveLength(2);
  });

  test("marks go to the frame as ids, anchors, counts and labels; found and activated name only those ids", async () => {
    const { bridge, events, tell, sent } = setup();
    bridge.annotations.setMarks([
      { id: "c1", anchor: { type: "element", data: { selector: "h1" } }, count: 2, label: "L1" },
      { id: "c2", anchor: { type: "text", data: { quote: "beta" } }, count: 1, label: "L2" },
    ]);
    const [{ params }] = sent("coforge/annotate/marks") as [{ params: { revision: number } }];
    expect(params).toMatchObject({
      revision: 1,
      marks: [
        { id: "c1", anchor: { type: "element", data: { selector: "h1" } }, count: 2, label: "L1" },
        { id: "c2", anchor: { type: "text", data: { quote: "beta" } }, count: 1, label: "L2" },
      ],
    });

    await tell("annotate-found", { revision: 1, ids: ["c2", "zzz", "c1", "c2"] });
    expect(events).toEqual([{ kind: "found", revision: 1, ids: ["c2", "c1"] }]);
    await tell("annotate-found", { revision: 0, ids: ["c1"] });
    expect(events).toHaveLength(1);

    await tell("annotate-activated", { id: "zzz" });
    expect(events).toHaveLength(1);
    bridge.annotations.configure({ picking: false, selecting: true, showMarks: false });
    await tell("annotate-activated", { id: "c1" });
    expect(events).toHaveLength(1);
    bridge.annotations.configure({ picking: false, selecting: true, showMarks: true });
    await tell("annotate-activated", { id: "c1" });
    expect(events.at(-1)).toEqual({ kind: "activated", id: "c1" });
  });

  test("a mark of an unsent draft carries its flag to the frame, and others carry none", () => {
    const { bridge, sent } = setup();
    bridge.annotations.setMarks([
      {
        id: "d1",
        anchor: { type: "text", data: { quote: "beta" } },
        count: 0,
        label: "D",
        draft: true,
      },
      { id: "c1", anchor: { type: "text", data: { quote: "alpha" } }, count: 1, label: "C" },
    ]);
    const [{ params }] = sent("coforge/annotate/marks") as [
      { params: { marks: Record<string, unknown>[] } },
    ];
    expect(params.marks[0]).toMatchObject({ id: "d1", count: 0, draft: true });
    expect(params.marks[1]).not.toHaveProperty("draft");
  });

  test("at most 500 marks are sent", () => {
    const { bridge, sent } = setup();
    bridge.annotations.setMarks(
      Array.from({ length: MARKS_MAX + 5 }, (_, i) => ({
        id: `c${i}`,
        anchor: { type: "element", data: { selector: "p" } },
        count: 1,
        label: "l",
      })),
    );
    const [{ params }] = sent("coforge/annotate/marks") as [{ params: { marks: unknown[] } }];
    expect(params.marks).toHaveLength(MARKS_MAX);
  });

  test("the frame's handshake keeps picking on, and its ready replays the mode, marks and draft", async () => {
    const { bridge, events, tell, sent, posted, frameWindow } = setup();
    bridge.annotations.configure({ picking: true, selecting: true, showMarks: true });
    bridge.annotations.setMarks([
      { id: "c1", anchor: { type: "element", data: { selector: "h1" } }, count: 1, label: "L" },
    ]);
    bridge.annotations.setDraft({ type: "element", data: { selector: "h1" } });
    posted.length = 0;

    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} },
    });
    expect(events).toEqual([]);
    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
    });
    expect(sent("coforge/annotate/mode").map((message) => message.params)).toEqual([
      { picking: true, selecting: true, showMarks: true },
    ]);
    expect(sent("coforge/annotate/marks")).toHaveLength(1);
    expect(sent("coforge/annotate/draft")).toHaveLength(1);
    await tell("annotate-selected", element());
    expect(events).toHaveLength(1);
  });

  test("marks sent to the frame are clipped to the limits an incoming anchor obeys", () => {
    const { bridge, sent } = setup();
    bridge.annotations.setMarks([
      {
        id: "c1",
        anchor: { type: "element", data: { selector: "s".repeat(1500), quote: "q".repeat(300) } },
        count: 1,
        label: "L",
      },
      {
        id: "c2",
        anchor: {
          type: "text",
          data: { quote: "t".repeat(5000), prefix: "p".repeat(200), suffix: "x".repeat(200) },
        },
        count: 1,
        label: "L",
      },
    ]);
    const [{ params }] = sent("coforge/annotate/marks") as [
      { params: { marks: { anchor: { data: Record<string, string> } }[] } },
    ];
    const [element, quotation] = params.marks.map((mark) => mark.anchor.data);
    expect([element!.selector!.length, element!.quote!.length]).toEqual([1000, 120]);
    expect([
      quotation!.quote!.length,
      quotation!.prefix!.length,
      quotation!.suffix!.length,
    ]).toEqual([4000, 64, 64]);
  });

  test("the handshake and its ready notice are rate limited, so a page cannot replay without end", async () => {
    let clock = 0;
    const { bridge, sent, posted, frameWindow } = setup({ now: () => clock });
    bridge.annotations.setMarks([
      { id: "c1", anchor: { type: "element", data: { selector: "h1" } }, count: 1, label: "L" },
    ]);
    posted.length = 0;
    const initialized = () =>
      bridge.handle({
        source: frameWindow as unknown as MessageEventSource,
        origin: ORIGIN,
        data: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      });
    const initialize = (id: number) =>
      bridge.handle({
        source: frameWindow as unknown as MessageEventSource,
        origin: ORIGIN,
        data: { jsonrpc: "2.0", id, method: "ui/initialize", params: {} },
      });
    for (let i = 0; i < 100; i += 1) await initialized();
    expect(sent("coforge/annotate/marks").length).toBe(30);
    for (let i = 0; i < 100; i += 1) await initialize(i + 1);
    const refused = posted.filter(
      (message) => (message.error as { message?: string } | undefined)?.message,
    );
    expect(refused.length).toBe(70);
    clock = 61_000;
    await initialized();
    expect(sent("coforge/annotate/marks").length).toBe(31);
  });

  test("focus and draft messages carry only what the host chose", () => {
    const { bridge, sent } = setup();
    bridge.annotations.focus("c1");
    bridge.annotations.setDraft({ type: "text", data: { quote: "beta" } });
    bridge.annotations.setDraft(null);
    expect(sent("coforge/annotate/focus")).toEqual([
      { jsonrpc: "2.0", method: "coforge/annotate/focus", params: { id: "c1" } },
    ]);
    expect(sent("coforge/annotate/draft").map((message) => message.params)).toEqual([
      { anchor: { type: "text", data: { quote: "beta" } } },
      { anchor: null },
    ]);
  });

  test("setDrafts clips and sends multiple referenced element anchors and replays them on ready", async () => {
    const { bridge, sent, frameWindow } = setup();
    bridge.annotations.setDrafts([
      { type: "element", data: { selector: "svg > use", quote: "<use>" } },
      { type: "element", data: { selector: "s".repeat(1200), quote: "q".repeat(200) } },
    ]);
    const [first] = sent("coforge/annotate/draft") as [
      {
        params: {
          anchor: { data: Record<string, string> };
          anchors?: { data: Record<string, string> }[];
        };
      },
    ];
    expect(first!.params.anchor.data.selector).toBe("svg > use");
    expect(first!.params.anchors).toHaveLength(2);
    expect(first!.params.anchors![1]!.data.selector!.length).toBe(1000);
    expect(first!.params.anchors![1]!.data.quote!.length).toBe(120);

    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
    });
    expect(sent("coforge/annotate/draft")).toHaveLength(2);

    bridge.annotations.setDrafts([]);
    expect(sent("coforge/annotate/draft").at(-1)?.params).toEqual({ anchor: null });
  });

  test("annotate-compose is accepted only while selecting is enabled and the viewer is active", async () => {
    let active = true;
    const { bridge, events, tell } = setup({ userActive: () => active });
    await tell("annotate-compose", {});
    expect(events).toEqual([]);

    bridge.annotations.configure({ picking: false, selecting: true, showMarks: false });
    active = false;
    await tell("annotate-compose", {});
    expect(events).toEqual([]);

    active = true;
    await tell("annotate-compose", {});
    expect(events).toEqual([{ kind: "compose" }]);
  });
});
