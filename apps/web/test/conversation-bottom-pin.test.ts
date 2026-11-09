import { expect, test } from "bun:test";

import { ConversationBottomPin } from "#src/features/conversations/conversation-bottom-pin";

/**
 * Where a pane opens (task #192). An open row the history cannot scroll far enough for lands at
 * the bottom; content that fills in afterwards (reactions, a thread's preview) must carry the
 * reader along, though native scroll anchoring's scroll event reaches the pin before the resize.
 */
function fakeHistory({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}) {
  let top = 0;
  const history = {
    scrollHeight,
    clientHeight,
    // A browser clamps the scroll position to what the content allows.
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.min(Math.max(0, value), history.scrollHeight - history.clientHeight);
    },
    scrollTo(options: { top: number }) {
      history.scrollTop = options.top;
    },
    getBoundingClientRect: () => ({ top: 0 }),
  };
  return history;
}
const rowAt = (top: number, history: { scrollTop: number }) => ({
  getBoundingClientRect: () => ({ top: top - history.scrollTop }),
});

test("an open row that fits above the end lands at the bottom and stays pinned through growth", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 2124, clientHeight: 577 });
  // The last row starts 300px above the end: scrolling its top into place would pass the bottom.
  const pinned = pin.open(history as never, rowAt(1824, history) as never);
  expect(pinned).toBe(true);
  expect(history.scrollTop).toBe(2124 - 577);
  // Rows above grow; native scroll anchoring moves the position part of the way and its scroll
  // event arrives first. It is not the reader moving away, so the resize still re-pins.
  history.scrollHeight = 2242;
  history.scrollTop += 71;
  expect(pin.scroll(history)).toBeUndefined();
  expect(pin.beforeResize(history)).toBe(true);
});

test("an open row with history below it scrolls its top into place and does not pin", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 4000, clientHeight: 577 });
  const pinned = pin.open(history as never, rowAt(1000, history) as never);
  expect(pinned).toBe(false);
  expect(history.scrollTop).toBe(1000 - 12);
});

/**
 * Scrolling up while rows still settle (task #567): the reader's input reaches the page before the
 * scroll it asks for is reported, and a row growing in between must not pull them back down.
 */
function pinnedAtBottom() {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 3000, clientHeight: 600 });
  pin.pin(history as never, "instant");
  return { pin, history };
}
const input = (history: object, event: Record<string, unknown>) =>
  ({ target: history, currentTarget: history, ...event }) as never;

test("input toward the top keeps a settling row from re-pinning until the scroll lands", () => {
  const { pin, history } = pinnedAtBottom();
  pin.read(input(history, { type: "wheel", deltaY: -120 }));
  history.scrollHeight = 3080;
  expect(pin.beforeResize(history)).toBe(false);
  // Native scroll anchoring's scroll event, still at the bottom, does not end the reader's move.
  history.scrollTop = history.scrollHeight - history.clientHeight;
  pin.scroll(history);
  expect(pin.beforeResize(history)).toBe(false);
  // The reader's scroll lands away from the bottom: distance decides again.
  history.scrollTop -= 400;
  expect(pin.scroll(history)).toBe(400);
  expect(pin.beforeResize(history)).toBe(false);
});

test("a small move up that stays within the bottom's tolerance keeps following", () => {
  const { pin, history } = pinnedAtBottom();
  pin.read(input(history, { type: "wheel", deltaY: -3 }));
  history.scrollTop -= 2;
  expect(pin.scroll(history)).toBe(2);
  history.scrollHeight = 3080;
  expect(pin.beforeResize(history)).toBe(true);
});

test("keys and a downward drag toward the top count as moving up", () => {
  for (const event of [
    { type: "keydown", key: "PageUp" },
    { type: "keydown", key: " ", shiftKey: true },
  ]) {
    const { pin, history } = pinnedAtBottom();
    pin.read(input(history, event));
    expect(pin.beforeResize(history)).toBe(false);
  }
  // The same key in a field being edited inside the history moves its caret instead.
  const editing = pinnedAtBottom();
  const field = { tagName: "TEXTAREA", isContentEditable: false };
  editing.pin.read({
    type: "keydown",
    key: "ArrowUp",
    target: field,
    currentTarget: editing.history,
  } as never);
  expect(editing.pin.beforeResize(editing.history)).toBe(true);
  const { pin, history } = pinnedAtBottom();
  pin.read(input(history, { type: "touchmove", touches: [{ identifier: 1, clientY: 300 }] }));
  expect(pin.beforeResize(history)).toBe(true);
  pin.read(input(history, { type: "touchmove", touches: [{ identifier: 1, clientY: 340 }] }));
  expect(pin.beforeResize(history)).toBe(false);
});

test("input toward the bottom, which scrolls nothing at the end, keeps following", () => {
  const { pin, history } = pinnedAtBottom();
  pin.read(input(history, { type: "wheel", deltaY: 120 }));
  pin.read(input(history, { type: "pointerdown" }));
  history.scrollHeight = 3080;
  expect(pin.beforeResize(history)).toBe(true);
  pin.pin(history as never, "instant");
  // Up, then back down before anything moved: following again.
  pin.read(input(history, { type: "wheel", deltaY: -120 }));
  pin.read(input(history, { type: "keydown", key: "End" }));
  expect(pin.beforeResize(history)).toBe(true);
});

test("moving up at the very top, or a jump to the latest, does not stop following", () => {
  const pin = new ConversationBottomPin();
  const short = fakeHistory({ scrollHeight: 500, clientHeight: 600 });
  pin.pin(short as never, "instant");
  pin.read(input(short, { type: "wheel", deltaY: -120 }));
  expect(pin.beforeResize(short)).toBe(true);
  const { pin: other, history } = pinnedAtBottom();
  other.read(input(history, { type: "wheel", deltaY: -120 }));
  other.pin(history as never, "instant");
  expect(other.beforeResize(history)).toBe(true);
});

/**
 * Landing away from the bottom (task #438): an open position or a message jump scrolls the
 * history, and a resize can come before that scroll's event. It is judged from the landing.
 */
test("a resize after an open position away from the bottom does not pull the reader back", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 4000, clientHeight: 577 });
  pin.pin(history as never, "instant");
  expect(pin.open(history as never, rowAt(1000, history) as never)).toBe(false);
  history.scrollHeight = 4060;
  expect(pin.beforeResize(history)).toBe(false);
});

test("a message jump's landing is where the next resize judges from", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 4000, clientHeight: 577 });
  pin.pin(history as never, "instant");
  history.scrollTop = 1200;
  expect(pin.landed(history as never)).toBe(false);
  history.scrollHeight = 4060;
  expect(pin.beforeResize(history)).toBe(false);
});

test("a jump to a row that lands at the bottom follows the latest from there", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 4000, clientHeight: 577 });
  // The last row, centered as far as the history allows: the bottom.
  history.scrollTop = 4000 - 577;
  expect(pin.landed(history as never)).toBe(true);
  history.scrollHeight = 4084;
  expect(pin.beforeResize(history)).toBe(true);
});

/** A history whose window stops short of the conversation's end: its newer page's sentinel shows. */
function shortWindow(scrollHeight: number, clientHeight: number) {
  return Object.assign(fakeHistory({ scrollHeight, clientHeight }), {
    querySelector: (selector: string) => (selector === "[data-newer-sentinel]" ? {} : null),
  });
}

test("the bottom of a window that stops short of the end is not the latest (task #34)", () => {
  const pin = new ConversationBottomPin();
  // A link to a channel's second message: the window around it fits on screen, newer pages below.
  const history = shortWindow(900, 577);
  history.scrollTop = 900 - 577;
  expect(pin.landed(history as never)).toBe(false);
  expect(pin.scroll(history)).toBe(Number.POSITIVE_INFINITY);
  // The newer page arrives below: nothing carries the reader down to it.
  history.scrollHeight = 2400;
  expect(pin.beforeResize(history)).toBe(false);
  // An open position there scrolls the row into place but does not pin either.
  const opened = new ConversationBottomPin();
  const open = shortWindow(900, 577);
  expect(opened.open(open as never, rowAt(800, open) as never)).toBe(false);
  expect(opened.beforeResize(open)).toBe(false);
});
